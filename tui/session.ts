import { compactWhitespace } from "../core/compactWhitespace";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import { DEFAULT_NOLO_SERVER_URL } from "../defaultServer";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
} from "../cliEnvHelpers";
import type { AgentRuntimeRequestedMode } from "../agentRuntimeLocal";
import {
  normalizeRenderDisplayMode,
  type RenderDisplayMode,
} from "../client/assistantOutput";
import {
  normalizeThinkingDisplayMode,
  type ThinkingDisplayMode,
} from "../client/thinkingOutput";
import { resolveCliColorEnabled } from "../client/terminalStyles";
import {
  formatTokenCount,
  renderTokenStatus,
  type TurnTokenUsage,
} from "../client/tokenUsage";
import {
  normalizeToolDisplayMode,
  type ToolDisplayMode,
} from "../client/toolOutput";
import {
  DEFAULT_TUI_AGENT_KEY,
  resolveCatalogPlatformAgents,
} from "./agentCatalog";
import { resolveAgentSwitchTarget } from "./agentPicker";
import type { AttachedImage } from "./pasteImage";
import { detectImagePaths, summarizeAttachment } from "./pasteImage";
import { parseCliLocale, setCliLocale, t } from "./i18n";
import {
  themeText,
  getActiveThemeName,
  setActiveThemeName,
  getActiveBrightness,
  setActiveBrightness,
  resolveTuiBrightness,
  surfaceBackgroundSequence,
  getActiveDensity,
  setActiveDensity,
  THEME_PALETTES,
} from "./theme";
import { detectGitStatus, type GitStatus } from "./gitStatus";
import { getProcessRegistry } from "../agent-runtime/processRegistry";

export { DEFAULT_TUI_AGENT_KEY };
export const DEFAULT_TUI_SERVER_URL = DEFAULT_NOLO_SERVER_URL;

export type TuiState = {
  agentKey: string;
  agentName: string;
  dialogId?: string;
  dialogKey?: string;
  dialogOwnerId?: string;
  dialogLabel: string;
  profileName: string;
  serverUrl: string;
  cliVersion?: string;
  /**
   * 用于解析 paste 行里的相对路径。workspace 启动时从 process.cwd() 取。
   * 保留在 state 里是为了让 handleTuiInput 这种纯函数也能做路径解析。
   */
  cwd: string;
  attachedDocs: string[];
  /**
   * 暂存 / paste 行解析到的图片附件。
   * 提交 chat 时会消费这些,转成 imageUrls 一起送出去。
   * /new 时清空,跟 attachedDocs 同语义。
   */
  attachedImages: AttachedImage[];
  runtimeMode: AgentRuntimeRequestedMode;
  /**
   * 显示在状态栏里的模式标签,默认等于 runtimeMode。
   * 可通过 NOLO_CLI_STATUS_MODE 覆盖,例如设置为 high。
   */
  modeLabel: string;
  gitStatus?: GitStatus;
  thinkingDisplay: ThinkingDisplayMode;
  toolDisplay: ToolDisplayMode;
  renderDisplay: RenderDisplayMode;
  turnTokens?: TurnTokenUsage;
};

export type TuiAction =
  | {
      type: "chat";
      message: string;
      agentKey: string;
      runtimeMode: AgentRuntimeRequestedMode;
      continueDialogId?: string;
      /**
       * 行内或 /attach 命令解析到的图片绝对路径。
       * 这里只携带路径,workspace loop 会异步读成 data URL 后拼 imageUrls。
       * 失败(ENOENT/超过大小/不是图片)的会被丢弃,留在 message 里给用户文本。
       */
      imagePaths?: string[];
    }
  | {
      type: "compact";
      dialogId: string;
    }
  | {
      type: "self-update";
    }
  | {
      type: "shell-command";
      command: string;
    }
  | {
      type: "cli-command";
      args: string[];
    }
  | {
      type: "pick-agent";
    }
  | {
      type: "list-agents";
    }
  | {
      type: "pick-dialog";
    }
  | {
      type: "set-locale";
      locale: "zh" | "en";
    }
  | {
      type: "copy-last";
    }
  | {
      type: "copy-view";
    }
  | {
      type: "set-mouse";
      enabled: boolean;
    }
  | {
      type: "attach-images";
      /**
       * 来自 /attach <path...> 命令,workspace 会异步读成 AttachedImage
       * 然后 merge 进 state.attachedImages。
       */
      paths: string[];
    }
  | {
      type: "clear";
    }
  | {
      type: "exit";
    };

export type TuiInputResult = {
  nextState: TuiState;
  output: string;
  action?: TuiAction;
};

type EnvLike = Record<string, string | undefined>;

export function createInitialTuiState(env: EnvLike = process.env): TuiState {
  const agentKey =
    asOptionalTrimmedString(env.NOLO_AGENT) ?? DEFAULT_TUI_AGENT_KEY;
  const agentName = asOptionalTrimmedString(env.NOLO_AGENT_NAME) ?? "nolo";
  const cwd = (
    asOptionalTrimmedString(env.NOLO_CWD) ?? process.cwd()
  ).replace(/\/+$/, "");
  const runtimeMode =
    env.NOLO_RUNTIME_MODE === "local" || env.NOLO_RUNTIME_MODE === "server"
      ? env.NOLO_RUNTIME_MODE
      : "auto";
  const dialogId = asOptionalTrimmedString(env.NOLO_DIALOG_ID);
  const dialogOwnerId =
    parseUserIdFromAuthToken(
      resolveAuthToken(env, ["BENCHMARK_AUTH_TOKEN"])
    ) || undefined;
  const dialogEnvValue = asOptionalTrimmedString(env.NOLO_DIALOG);
  const explicitDialogKey =
    asOptionalTrimmedString(env.NOLO_DIALOG_KEY) ??
    (dialogEnvValue?.startsWith("dialog-") ? dialogEnvValue : undefined);

  return {
    agentKey,
    agentName,
    dialogId,
    dialogKey:
      explicitDialogKey ??
      (dialogId && dialogOwnerId
        ? `dialog-${dialogOwnerId}-${dialogId}`
        : undefined),
    dialogOwnerId,
    dialogLabel: dialogEnvValue ?? "new",
    profileName: asOptionalTrimmedString(env.NOLO_PROFILE) ?? "local",
    serverUrl: (env.NOLO_SERVER || env.BASE_URL || DEFAULT_TUI_SERVER_URL).replace(
      /\/+$/,
      ""
    ),
    cliVersion: asOptionalTrimmedString(env.NOLO_CLI_VERSION),
    cwd,
    attachedDocs: [],
    attachedImages: [],
    runtimeMode,
    modeLabel:
      asOptionalTrimmedString(env.NOLO_CLI_STATUS_MODE) ?? runtimeMode,
    gitStatus:
      env.NOLO_CLI_GIT_STATUS === "0" ? undefined : detectGitStatus(cwd),
    thinkingDisplay: normalizeThinkingDisplayMode(
      env.NOLO_CLI_THINKING ?? env.NOLO_THINKING,
      "hide"
    ),
    toolDisplay: normalizeToolDisplayMode(env.NOLO_CLI_TOOLS ?? env.NOLO_TOOLS, "compact"),
    renderDisplay: normalizeRenderDisplayMode(env.NOLO_CLI_RENDER ?? env.NOLO_RENDER, "rich"),
  };
}

function formatCwd(cwd: string) {
  const parts = cwd.split(/[/\\]/);
  return parts.pop() || cwd;
}

function formatElapsedSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/** Soft token chip for the composer status line (no powerline background). */
function renderComposerTokenChip(tokens?: TurnTokenUsage) {
  if (!tokens || !tokens.contextWindow) {
    return "◫ —";
  }
  const used = tokens.input + tokens.output;
  const pct = Math.min(100, (used / tokens.contextWindow) * 100);
  const pctText = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  return `◫ ${pctText}%/${formatTokenCount(tokens.contextWindow)}`;
}

export function renderStatusLine(state: TuiState) {
  const colorEnabled = resolveCliColorEnabled();
  // OMP-style chips: soft fg colors + " · " separators. No solid powerline
  // backgrounds — those break box layout when the line is long.
  //
  // Segments use semantic theme tokens rather than raw ANSI color names. The
  // status line is the most visible chrome in the TUI, and hardcoding colors
  // here meant `/theme` visibly changed everything except it. Each token
  // carries an ANSI-16 fallback, so terminals without truecolor still get the
  // saturated, light/dark-safe colors the raw names used to provide.
  const sep = themeText(" · ", "chrome", colorEnabled);

  // 自动路由开启且未显式选择 agent 时，状态行显示 auto（实际档位在首轮
  // 分类后确定并打印 auto → tier）；显式选择的 agent 是 model 层覆盖源，
  // 显示其名。NOLO_AUTO_ROUTE=0 时恢复显示默认 agent 名。
  const autoRouteActive =
    state.agentKey === DEFAULT_TUI_AGENT_KEY &&
    (typeof process === "undefined" || process.env?.NOLO_AUTO_ROUTE !== "0");
  const agentDisplayName = autoRouteActive ? "auto" : state.agentName;
  // 路由已是 auto 时隐藏重复的 runtime-mode auto 标签，避免 "auto · auto"。
  const modeSuffix =
    state.modeLabel && !(autoRouteActive && state.modeLabel === "auto")
      ? ` · ${state.modeLabel}`
      : "";
  const agentLabel = `🏔 ${agentDisplayName}${modeSuffix}`;
  const agentSegment = themeText(agentLabel, "accent", colorEnabled);

  const cwdSegment = themeText(`📁 ${formatCwd(state.cwd)}`, "info", colorEnabled);

  const parts: string[] = [agentSegment, cwdSegment];

  if (state.gitStatus) {
    const { branch, modified, untracked } = state.gitStatus;
    const branchText = themeText(`⑂ ${branch}`, "warning", colorEnabled);
    // Modified files are the actionable signal (danger); untracked is noise
    // (muted). Keeping them different tokens preserves that hierarchy.
    const modifiedText = modified > 0 ? ` ${themeText(`*${modified}`, "danger", colorEnabled)}` : "";
    const untrackedText = untracked > 0 ? ` ${themeText(`?${untracked}`, "muted", colorEnabled)}` : "";
    parts.push(`${branchText}${modifiedText}${untrackedText}`);
  }

  const tokenSegment = themeText(renderComposerTokenChip(state.turnTokens), "muted", colorEnabled);
  parts.push(tokenSegment);

  const runningCount = getProcessRegistry().list().filter(p => p.status === "running").length;
  if (runningCount > 0) {
    parts.push(themeText(`⚙ ${runningCount} running`, "info", colorEnabled));
  }

  const body = parts.join(sep);
  const surface = colorEnabled ? surfaceBackgroundSequence() : "";
  if (!surface) return body;

  // A surface wash plus one space of padding turns the run of segments into a
  // single chip instead of loose text floating on the composer.
  //
  // Deliberately no bracket glyphs: the rounded caps this imitates are
  // powerline codepoints (U+E0B4/U+E0B6) that only exist in patched Nerd
  // Fonts, and box-drawing corners are the wrong semantic mid-line. There is
  // no way to detect the font, and a chip that renders as tofu is worse than
  // one defined by its fill alone.
  //
  // The fill itself is truecolor-only (see surfaceBackgroundSequence) — ANSI-16
  // has no subtle background, only solid blocks that would bury the text.
  //
  // \x1b[49m resets background only, so callers can keep appending
  // foreground-colored text (the "· Esc to stop" hint) after the chip closes.
  return `${surface} ${body} \x1b[49m`;
}

export function renderWelcome(state: TuiState) {
  const versionStr = state.cliVersion ? `nolo ${state.cliVersion}` : "nolo";
  const colorEnabled = resolveCliColorEnabled();

  const mountainArt = [
    "       🏔",
    "      / \\_",
    "    _/    \\_/\x1b[1m nolo\x1b[22m",
    "  _/        \\_",
    "_/            \\_______________________",
  ].map(line => themeText(line, "chrome", colorEnabled)).join("\n");

  return [
    mountainArt,
    `${versionStr} | server ${state.serverUrl}`,
    t("welcomeHint"),
    "",
  ].join("\n");
}

export function renderPrompt(_state: TuiState) {
  return t("promptLabel");
}

export type TuiKeyInfo = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
};

export type TuiInputKeyResult = {
  buffer: string;
  submit?: string;
  abort?: boolean;
  copyView?: boolean;
};

export function applyTuiInputKey(
  buffer: string,
  sequence: string | undefined,
  key: TuiKeyInfo = {}
): TuiInputKeyResult {
  const seq = sequence ?? "";
  if (seq === "\u0003" || (key.ctrl && key.name === "c")) {
    return { buffer, abort: true };
  }
  if (seq === "\u000f" || (key.ctrl && key.name === "o")) {
    return { buffer, copyView: true };
  }
  if (
    seq === "\x1b[13;2~" ||
    seq === "\x1b[27;2;13~" ||
    seq === "\x1b\r" ||
    (key.shift && (key.name === "enter" || key.name === "return")) ||
    seq === "\n" ||
    (key.ctrl && key.name === "j")
  ) {
    return { buffer: `${buffer}\n` };
  }
  if (key.name === "enter" || key.name === "return" || seq === "\r") {
    return { buffer: "", submit: buffer };
  }
  // Backspace / Delete (incl. modifier variants).
  // Plain: \b (0x08), \x7f (DEL). Alt+Backspace: \x1b\x7f / \x1b\b (split into
  // ESC + DEL by splitRawInput, so the DEL half reaches here as \x7f/\b).
  // Ctrl/Shift+Backspace on modern terminals: \x1b[3;5~ / \x1b[27;2;8~.
  // Forward Delete and modifier Delete: \x1b[3~ and \x1b[3;{modifier}~.
  // In a single-line buffer, forward-delete behaves like backspace.
  if (
    key.name === "backspace" ||
    key.name === "delete" ||
    seq === "\b" ||
    seq === "\x7f" ||
    isDeleteFamilyCsi(seq)
  ) {
    if (buffer.length > 0) {
      return { buffer: buffer.slice(0, -1) };
    }
    return { buffer };
  }
  if (seq === "\t" || key.name === "tab") {
    // Tab-complete slash commands: unique match fills the whole command
    // (plus a trailing space, ready for arguments), multiple matches extend
    // to their longest common prefix. Never inserts a literal tab.
    return { buffer: completeSlashPrefix(buffer) ?? buffer };
  }
  if (!seq || key.ctrl || key.meta || seq.startsWith("\x1b")) {
    return { buffer };
  }
  return { buffer: `${buffer}${seq}` };
}

/**
 * Match CSI sequences for Backspace/Delete with modifier keys.
 *
 * Terminals encode modifier keys in the CSI parameter: `\x1b[3;{m}~` for
 * Delete variants and some terminals use `\x1b[27;{m};{code}~` for Backspace
 * variants. We accept any modifier (2=shift, 3=alt, 5=ctrl, etc.) and any
 * base (3=Delete, 8=Backspace), since in a single-line TUI buffer they all
 * just delete the last character.
 */
function isDeleteFamilyCsi(seq: string): boolean {
  // Delete family: ESC [ 3 [; modifier] ~  (e.g. \x1b[3~, \x1b[3;2~, \x1b[3;5~)
  // eslint-disable-next-line no-control-regex
  if (/^\x1b\[3(?:;\d+)*~$/.test(seq)) return true;
  // Backspace family: ESC [ 27 ; modifier ; 8 ~ (e.g. \x1b[27;2;8~)
  // eslint-disable-next-line no-control-regex
  if (/^\x1b\[27;\d+;8~$/.test(seq)) return true;
  return false;
}

/**
 * Tab completion for a partial slash command. Returns the new buffer, or
 * null when the buffer is not a completable command prefix (not a slash
 * command, already has arguments, or nothing matches).
 */
export function completeSlashPrefix(buffer: string): string | null {
  if (!buffer.startsWith("/") || /\s/.test(buffer)) return null;
  const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(buffer));
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return `${matches[0]} `;
  }
  let prefix: string = matches[0];
  for (const cmd of matches) {
    while (!cmd.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.length > buffer.length ? prefix : null;
}

export const SLASH_COMMANDS = [
  "/help",
  "/compact",
  "/theme",
  "/density",
  "/context",
  "/ctx",
  "/runtime",
  "/tools",
  "/thinking",
  "/render",
  "/switch",
  "/agent",
  "/agents",
  "/history",
  "/resume",
  "/lang",
  "/copy",
  "/mouse",
  "/doc",
  "/customize",
  "/login",
  "/profile",
  "/update",
  "/version",
  "/tasks",
  "/jobs",
  "/procs",
  "/stop",
  "/exit",
  "/quit",
] as const;

export function completeSlashCommand(buffer: string): string[] {
  if (!buffer.startsWith("/")) return [];
  const trimmed = buffer.trim();
  if (trimmed.includes(" ")) return [];
  return SLASH_COMMANDS.filter((cmd) => cmd.startsWith(trimmed) && cmd !== trimmed);
}

export function renderTuiHelp() {
  return t("helpText");
}

export function renderContextPanel(state: TuiState) {
  const docs = state.attachedDocs.length
    ? state.attachedDocs.join(", ")
    : "none";
  return [
    "Workspace context",
    "-----------------",
    `agent    ${state.agentName} (${state.agentKey})`,
    `tokens   ${renderTokenStatus(state.turnTokens)}`,
    `dialog   ${
      state.dialogKey ?? (state.dialogId ? "unavailable" : state.dialogLabel)
    }`,
    `docs     ${docs}`,
    `配置     ${state.profileName}`,
    `runtime  ${state.runtimeMode}`,
    `tools    ${state.toolDisplay}`,
    `thinking ${state.thinkingDisplay}`,
    `render   ${state.renderDisplay}`,
    `server   ${state.serverUrl}`,
    "",
    "Next:",
    "  /agents              see specialist shortcuts",
    "  /doc attach <doc>    add working context",
    "  /new                 start a clean dialog",
  ].join("\n");
}

export function renderKnownAgents() {
  return [
    "Agents:",
    ...resolveCatalogPlatformAgents().map(
      (agent, index) =>
        `  ${index + 1}  ${agent.name.padEnd(11)} ${agent.description ?? ""}`
    ),
    "",
    "Tip: run /switch for the full picker, or /switch list for your private agents too.",
  ].join("\n");
}

function applyAgentSwitch(state: TuiState, target: { name: string; key: string }) {
  return {
    nextState: {
      ...state,
      agentName: target.name,
      agentKey: target.key,
    },
    output: `Switched to ${target.name}. ${
      state.dialogId ? `Dialog kept: ${state.dialogId}` : "Dialog kept: new"
    }`,
  };
}

// Removed natural language TUI routing helper functions and patterns as natural language inputs are now directly handled by the AI agent.

/**
 * 判断一行 input 是不是 slash 命令。
 *
 * 关键陷阱:Unix 绝对路径都以 `/` 开头(`/Users/foo`),而 slash 命令也是
 * `/foo`。直接 `startsWith("/")` 会把 paste 进来的文件路径当成 unknown slash
 * command。
 *
 * 判别规则:
 * - 必须以 `/` 开头
 * - 第一个 token(到首个空白前)必须 match `/[a-zA-Z_][a-zA-Z0-9._:-]*`
 *   这同时排除两个情况:
 *   1. 路径(`/Users/foo`,因为 token 含第二个 `/`,regex 不匹配)
 *   2. 数字开头(`/123abc` 不是合法命令名)
 *
 * 这样 `/help`、`/switch list`、`/attach /tmp/x.png` 都正确判为 slash,
 * `/Users/x.png 看图`、`/etc/hosts` 都正确判为 chat。
 */
export function isLikelySlashCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;
  const spaceIdx = trimmed.search(/\s/);
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return /^\/[a-zA-Z_][a-zA-Z0-9._:-]*$/.test(firstToken);
}

/**
 * 把 hints 对应的 raw token 从 message 里 strip 掉。
 * 用于"看图 /Users/foo/a.png 怎么样"这种:路径不应该作为文本发给 LLM。
 *
 * - strip 后空了就保留原 message(避免空 message,workspace 仍然发图片)
 * - 失败的 hint 不会出现在这里(只有 sync 阶段确认的路径才会传进来)
 */
export function stripImageTokens(input: string, hints: { raw: string }[]): string {
  if (hints.length === 0) return input;
  let out = input;
  for (const hint of hints) {
    if (!hint.raw) continue;
    const escaped = hint.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "");
  }
  return compactWhitespace(out);
}

export function handleTuiInput(input: string, state: TuiState): TuiInputResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { nextState: state, output: "" };
  }

  if (trimmed.startsWith("!")) {
    const cmd = trimmed.slice(1).trim();
    return {
      nextState: state,
      output: "",
      action: {
        type: "shell-command",
        command: cmd,
      },
    };
  }

  if (!isLikelySlashCommand(trimmed)) {
    const hints = detectImagePaths(trimmed, state.cwd);
    const stripped = stripImageTokens(trimmed, hints);
    const finalMessage = stripped.length > 0 ? stripped : trimmed;
    const imagePaths = hints.map((hint) => hint.resolvedPath);
    const preview =
      hints.length > 0
        ? hints.map((hint) => `found image: ${hint.resolvedPath}`).join("\n")
        : "";

    return {
      nextState: state,
      output: preview,
      action: {
        type: "chat",
        message: finalMessage,
        agentKey: state.agentKey,
        runtimeMode: state.runtimeMode,
        ...(state.dialogId ? { continueDialogId: state.dialogId } : {}),
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
      },
    };
  }

  const [command = "", ...rest] = trimmed.split(/\s+/);
  const argText = rest.join(" ").trim();

  switch (command) {
    case "/help":
      return { nextState: state, output: renderTuiHelp() };
    case "/theme": {
      const parts = argText.split(/\s+/);
      const sub = parts[0]?.trim();
      const available = Object.keys(THEME_PALETTES).join(", ");
      if (!sub) {
        const brightness = getActiveBrightness() ?? `${resolveTuiBrightness()} (auto)`;
        return {
          nextState: state,
          output: [
            `Current theme: ${getActiveThemeName()} · ${brightness}`,
            `Usage: /theme <name> | /theme light | /theme dark`,
            `Available themes: ${available}`,
          ].join("\n"),
        };
      }
      // Brightness is a separate axis from the palette family: the same theme
      // has a light and a dark variant, and picking the wrong one is what makes
      // colors look washed out. It was previously reachable only through the
      // NOLO_TUI_THEME env var, which nobody discovers.
      if (sub === "light" || sub === "dark") {
        setActiveBrightness(sub);
        return { nextState: state, output: `Switched to ${sub} background colors.` };
      }
      if (sub === "auto") {
        setActiveBrightness(null);
        return {
          nextState: state,
          output: `Background colors follow terminal detection (now: ${resolveTuiBrightness()}).`,
        };
      }
      if (setActiveThemeName(sub)) {
        return {
          nextState: state,
          output: `Switched to theme: ${sub}`,
        };
      } else {
        return {
          nextState: state,
          output: `Unknown theme: ${sub}. Available themes: ${available}`,
        };
      }
    }
    case "/density": {
      const parts = argText.split(/\s+/);
      const sub = parts[0]?.trim();
      if (!sub) {
        return {
          nextState: state,
          output: `Current density: ${getActiveDensity()}\nUsage: /density <cozy|spacious>`,
        };
      }
      if (sub === "cozy" || sub === "spacious") {
        setActiveDensity(sub);
        return {
          nextState: state,
          output: `Switched to layout density: ${sub}`,
        };
      } else {
        return {
          nextState: state,
          output: `Unknown density: ${sub}. Use 'cozy' or 'spacious'.`,
        };
      }
    }
    case "/context":
    case "/ctx":
      return { nextState: state, output: renderContextPanel(state) };
    case "/runtime": {
      if (argText !== "auto" && argText !== "local" && argText !== "server") {
        return {
          nextState: state,
          output: "Usage: /runtime <auto|local|server>",
        };
      }
      return {
        nextState: { ...state, runtimeMode: argText },
        output: `Runtime: ${argText}`,
      };
    }
    case "/tools": {
      if (!argText) {
        return {
          nextState: state,
          output: `Tool display: ${state.toolDisplay} (hide | compact | verbose)`,
        };
      }
      const normalizedArg = asTrimmedLowercaseString(argText);
      if (!["hide", "compact", "verbose", "on", "off"].includes(normalizedArg)) {
        return {
          nextState: state,
          output: "Usage: /tools <hide|compact|verbose>",
        };
      }
      const nextMode = normalizeToolDisplayMode(normalizedArg, state.toolDisplay);
      return {
        nextState: { ...state, toolDisplay: nextMode },
        output: `Tool display: ${nextMode}`,
      };
    }
    case "/thinking": {
      if (!argText) {
        return {
          nextState: state,
          output: `Thinking display: ${state.thinkingDisplay} (hide | marker | show)`,
        };
      }
      const normalizedArg = asTrimmedLowercaseString(argText);
      if (!["hide", "marker", "show", "on", "off"].includes(normalizedArg)) {
        return {
          nextState: state,
          output: "Usage: /thinking <hide|marker|show>",
        };
      }
      const nextMode = normalizeThinkingDisplayMode(normalizedArg, state.thinkingDisplay);
      return {
        nextState: { ...state, thinkingDisplay: nextMode },
        output: `Thinking display: ${nextMode}`,
      };
    }
    case "/render": {
      if (!argText) {
        return {
          nextState: state,
          output: `Render display: ${state.renderDisplay} (plain | rich)`,
        };
      }
      const normalizedArg = asTrimmedLowercaseString(argText);
      if (!["plain", "rich", "on", "off"].includes(normalizedArg)) {
        return {
          nextState: state,
          output: "Usage: /render <plain|rich>",
        };
      }
      const nextMode = normalizeRenderDisplayMode(normalizedArg, state.renderDisplay);
      return {
        nextState: { ...state, renderDisplay: nextMode },
        output: `Render display: ${nextMode}`,
      };
    }
    case "/tasks":
    case "/jobs":
    case "/procs": {
      const registry = getProcessRegistry();
      const all = registry.list();
      const running = all.filter(p => p.status === "running");
      const stopped = all.filter(p => p.status !== "running");
      const lines: string[] = [];
      if (running.length > 0) {
        lines.push(`Running processes (${running.length}):`);
        for (const p of running) {
          const elapsed = formatElapsedSeconds(Math.floor((Date.now() - p.startedAt) / 1000));
          lines.push(`  pid ${p.pid}  ${p.label}    running  ${elapsed}`);
        }
      }
      if (stopped.length > 0) {
        lines.push(`Stopped/exited (${stopped.length}):`);
        for (const p of stopped) {
          const elapsed = formatElapsedSeconds(Math.floor((Date.now() - p.startedAt) / 1000));
          const exitInfo = p.exitCode !== undefined ? `  exit ${p.exitCode}` : "";
          lines.push(`  pid ${p.pid}  ${p.label}    ${p.status}${exitInfo ? ` ${exitInfo}` : ""}  ${elapsed}`);
        }
      }
      if (all.length === 0) {
        lines.push("No processes.");
      }
      return { nextState: state, output: lines.join("\n") };
    }
    case "/stop": {
      const registry = getProcessRegistry();
      if (!argText) {
        return { nextState: state, output: "Usage: /stop <pid|label|all>" };
      }
      if (argText === "all") {
        const before = registry.list().filter(p => p.status === "running").length;
        registry.stopAll();
        return { nextState: state, output: `Stopped ${before} processes` };
      }
      if (/^\d+$/.test(argText)) {
        const pid = parseInt(argText, 10);
        const proc = registry.get(pid);
        if (!proc || proc.status !== "running") {
          return { nextState: state, output: `No running process with pid ${pid}` };
        }
        registry.kill(pid);
        return { nextState: state, output: `Stopped pid ${pid} (${proc.label})` };
      }
      // Match by label
      const matches = registry.list().filter(p => p.status === "running" && p.label === argText);
      if (matches.length === 0) {
        return { nextState: state, output: `No running process labeled '${argText}'` };
      }
      for (const p of matches) {
        registry.kill(p.pid);
      }
      const stoppedNames = matches.map(p => `pid ${p.pid} (${p.label})`).join(", ");
      return { nextState: state, output: `Stopped ${stoppedNames}` };
    }
    case "/exit":
    case "/quit":
      return { nextState: state, output: t("bye"), action: { type: "exit" } };
    case "/new":
      return {
        nextState: {
          ...state,
          dialogId: undefined,
          dialogKey: undefined,
          dialogLabel: t("newDialog"),
          attachedDocs: [],
          attachedImages: [],
          turnTokens: undefined,
        },
        output: t("startedFreshDialog"),
        action: { type: "clear" },
      };
    case "/compact":
      if (argText) {
        return {
          nextState: state,
          output: `Unknown command: ${trimmed}\n\n${renderTuiHelp()}`,
        };
      }
      if (!state.dialogId) {
        return {
          nextState: state,
          output: "Current dialog: new (nothing to compact yet)",
        };
      }
      return {
        nextState: state,
        output: "Compacting current dialog...",
        action: { type: "compact", dialogId: state.dialogId },
      };
    case "/agent":
    case "/switch": {
      if (!argText) {
        return {
          nextState: state,
          output: "",
          action: { type: "pick-agent" },
        };
      }
      if (argText === "list") {
        return {
          nextState: state,
          output: "",
          action: { type: "list-agents" },
        };
      }
      if (argText === "current" || argText === "show") {
        return {
          nextState: state,
          output: `Current agent: ${state.agentName} (${state.agentKey})`,
        };
      }
      const resolvedTarget = resolveAgentSwitchTarget(argText, resolveCatalogPlatformAgents());
      if (!resolvedTarget) {
        return {
          nextState: state,
          output:
            `I don't know agent "${argText}" yet.\n` +
            "Use /switch, /switch list, /switch minimax-m3, or a full agent key.",
        };
      }
      return applyAgentSwitch(state, resolvedTarget);
    }
    case "/agents":
      return {
        nextState: state,
        output: renderKnownAgents(),
      };
    case "/lang": {
      const locale = parseCliLocale(argText);
      if (!locale) {
        return { nextState: state, output: t("langUsage") };
      }
      setCliLocale(locale);
      return {
        nextState: state,
        output: t("langSwitched"),
        action: { type: "set-locale", locale },
      };
    }
    case "/history":
      return {
        nextState: state,
        output: "",
        action: { type: "pick-dialog" },
      };
    case "/copy":
      if (argText === "view") {
        return {
          nextState: state,
          output: "",
          action: { type: "copy-view" },
        };
      }
      if (argText) {
        return { nextState: state, output: t("copyUsage") };
      }
      return {
        nextState: state,
        output: "",
        action: { type: "copy-last" },
      };
    case "/mouse": {
      if (argText !== "on" && argText !== "off") {
        return { nextState: state, output: t("mouseUsage") };
      }
      return {
        nextState: state,
        output: argText === "on" ? t("mouseOn") : t("mouseOff"),
        action: { type: "set-mouse", enabled: argText === "on" },
      };
    }
    case "/resume": {
      if (!argText) {
        return {
          nextState: state,
          output: "",
          action: { type: "pick-dialog" },
        };
      }
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(argText)) {
        return {
          nextState: state,
          output: `"${argText}" ${t("resumeInvalidId")}`,
        };
      }
      return {
        nextState: {
          ...state,
          dialogId: argText,
          dialogKey: state.dialogOwnerId
            ? `dialog-${state.dialogOwnerId}-${argText}`
            : undefined,
          dialogLabel: argText,
          turnTokens: undefined,
        },
        output: `${t("resumedDialogPrefix")}: ${argText}`,
      };
    }
    case "/doc": {
      if (rest[0] === "attach") {
        const docName = rest.slice(1).join(" ").trim();
        if (!docName) {
          return { nextState: state, output: "Usage: /doc attach <doc>" };
        }
        const attachedDocs = state.attachedDocs.includes(docName)
          ? state.attachedDocs
          : [...state.attachedDocs, docName];
        return {
          nextState: { ...state, attachedDocs },
          output: `Attached doc: ${docName}`,
        };
      }
      return {
        nextState: state,
        output:
          state.attachedDocs.length > 0
            ? `Attached docs: ${state.attachedDocs.join(", ")}`
            : "No docs attached. Use /doc attach <doc>.",
      };
    }
    case "/customize":
      return {
        nextState: state,
        output:
          "Tell nolo what to change, for example: /customize make my default agent more concise.",
      };
    case "/login":
      return {
        nextState: state,
        output:
          "MVP login uses profile/env auth. Set AUTH_TOKEN, NOLO_SERVER, or NOLO_PROFILE before starting nolo.",
      };
    case "/profile":
      return {
        nextState: state,
        output: `当前配置环境 (Profile): ${state.profileName}`,
      };
    case "/update":
      return {
        nextState: state,
        output: "Starting self-update...",
        action: { type: "self-update" },
      };
    case "/version":
      return {
        nextState: state,
        output:
          `nolo ${state.cliVersion || "unknown version"}\n` +
          "Update this install with: nolo update\n" +
          "If repo-local output differs, publish/install the latest npm package first.",
      };
    default:
      return {
        nextState: state,
        output: `Unknown command: ${command}\n\n${renderTuiHelp()}`,
      };
  }
}
