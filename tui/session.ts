import { compactWhitespace } from "../core/compactWhitespace";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import { DEFAULT_NOLO_SERVER_URL } from "../defaultServer";
import type { AgentRuntimeRequestedMode } from "../agentRuntimeLocal";
import {
  normalizeRenderDisplayMode,
  type RenderDisplayMode,
} from "../client/assistantOutput";
import {
  normalizeThinkingDisplayMode,
  type ThinkingDisplayMode,
} from "../client/thinkingOutput";
import {
  dimCliText,
  resolveCliColorEnabled,
  styleCliText,
} from "../client/terminalStyles";
import {
  formatTokenCount,
  renderTokenStatus,
  type TurnTokenUsage,
} from "../client/tokenUsage";
import {
  normalizeToolDisplayMode,
  type ToolDisplayMode,
} from "../client/toolOutput";
import { DEFAULT_TUI_AGENT_KEY, PLATFORM_AGENTS } from "./agentCatalog";
import { resolveAgentSwitchTarget } from "./agentPicker";
import type { AttachedImage } from "./pasteImage";
import { detectImagePaths, summarizeAttachment } from "./pasteImage";
import { t } from "./i18n";
import { detectGitStatus, type GitStatus } from "./gitStatus";

export { DEFAULT_TUI_AGENT_KEY };
export const DEFAULT_TUI_SERVER_URL = DEFAULT_NOLO_SERVER_URL;

function shortenDialogId(dialogId: string) {
  return dialogId.length > 12
    ? `${dialogId.slice(0, 6)}...${dialogId.slice(-4)}`
    : dialogId;
}

export function resolveDialogLabel(
  state: Pick<TuiState, "dialogId" | "dialogLabel">
) {
  return state.dialogId ? shortenDialogId(state.dialogId) : state.dialogLabel;
}

export type TuiState = {
  agentKey: string;
  agentName: string;
  dialogId?: string;
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

  return {
    agentKey,
    agentName,
    dialogId: asOptionalTrimmedString(env.NOLO_DIALOG_ID),
    dialogLabel: asOptionalTrimmedString(env.NOLO_DIALOG) ?? "new",
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
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
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
  // OMP-style chips: soft fg colors + " > " separators. No solid powerline
  // backgrounds — those break box layout when the line is long.
  const sep = dimCliText(" > ", colorEnabled);

  const logoSegment = styleCliText("nolo", "cyan", colorEnabled);

  const agentLabel = `⬢ ${state.agentName}${state.modeLabel ? ` · ${state.modeLabel}` : ""}`;
  const agentSegment = styleCliText(agentLabel, "magenta", colorEnabled);

  const cwdSegment = styleCliText(`📁 ${formatCwd(state.cwd)}`, "blue", colorEnabled);

  const parts: string[] = [logoSegment, agentSegment, cwdSegment];

  if (state.gitStatus) {
    const { branch, modified, untracked } = state.gitStatus;
    const statusMarkers = [
      modified > 0 ? `*${modified}` : "",
      untracked > 0 ? `?${untracked}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const gitText = statusMarkers ? `⑂ ${branch} ${statusMarkers}` : `⑂ ${branch}`;
    parts.push(styleCliText(gitText, "yellow", colorEnabled));
  }

  const tokenSegment = dimCliText(renderComposerTokenChip(state.turnTokens), colorEnabled);
  parts.push(tokenSegment);

  return parts.join(sep);
}

export function renderWelcome(state: TuiState) {
  const versionStr = state.cliVersion ? `nolo ${state.cliVersion}` : "nolo";
  return [
    `${versionStr} | server ${state.serverUrl}`,
    t("welcomeHint"),
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
  if (key.name === "backspace" || key.name === "delete" || seq === "\b" || seq === "\x7f") {
    return { buffer: buffer.slice(0, -1) };
  }
  if (!seq || key.ctrl || key.meta || seq.startsWith("\x1b")) {
    return { buffer };
  }
  return { buffer: `${buffer}${seq}` };
}

export const SLASH_COMMANDS = [
  "/help",
  "/clear",
  "/compact",
  "/context",
  "/ctx",
  "/runtime",
  "/tools",
  "/thinking",
  "/render",
  "/agent",
  "/agents",
  "/switch",
  "/dialog",
  "/doc",
  "/customize",
  "/login",
  "/profile",
  "/update",
  "/version",
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
  return [
    "Commands:",
    "  /help                 Show this help",
    "  /new                  Start a fresh dialog",
    "  /clear                Clear screen and start a fresh dialog",
    "  /compact              Compact current dialog and fork a new one",
    "  /context              Show workspace context and next actions",
    "  /runtime <mode>       Use auto, local, or server runtime",
    "  /tools <mode>         Control tool trace: hide, compact, verbose",
    "  /thinking <mode>      Control thinking output: hide, marker, show",
    "  /render <mode>        Control assistant output: plain, rich",
    "  /agent                Pick an agent interactively (↑↓, Enter)",
    "  /agent list           List agents as text",
    "  /agent <name>         Switch directly by name, alias, or key",
    "  /agents               List platform agent shortcuts",
    "  /switch <agent>       Switch the current agent (alias of /agent <name>)",
    "  /dialog               Show the current dialog",
    "  /doc                  List attached docs",
    "  /doc attach <doc>     Attach a doc to this workspace",
    "  /customize            Describe how you want to tune nolo",
    "  /login                Show login/profile hint",
    "  /profile              Show active profile (显示当前配置环境)",
    "  /update               Update the nolo CLI install",
    "  /version              Show version/update hint",
    "  /exit                 Leave the workspace",
    "",
    "You can also type normally. nolo routes simple read/status requests to CLI commands and sends the rest to the current agent.",
  ].join("\n");
}

export function renderContextPanel(state: TuiState) {
  const docs = state.attachedDocs.length
    ? state.attachedDocs.join(", ")
    : "none";
  return [
    "Workspace context",
    "-----------------",
    `agent    ${state.agentName}`,
    `tokens   ${renderTokenStatus(state.turnTokens)}`,
    `dialog   ${resolveDialogLabel(state)}`,
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
    ...PLATFORM_AGENTS.map(
      (agent, index) =>
        `  ${index + 1}  ${agent.name.padEnd(11)} ${agent.description ?? ""}`
    ),
    "",
    "Tip: run /agent for the full picker, or /agent list for your private agents too.",
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
 * 这样 `/help`、`/agent list`、`/attach /tmp/x.png` 都正确判为 slash,
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
    case "/exit":
    case "/quit":
      return { nextState: state, output: t("bye"), action: { type: "exit" } };
    case "/new":
      return {
        nextState: {
          ...state,
          dialogId: undefined,
          dialogLabel: t("newDialog"),
          attachedDocs: [],
          attachedImages: [],
          turnTokens: undefined,
        },
        output: t("startedFreshDialog"),
      };
    case "/clear":
      return {
        nextState: {
          ...state,
          dialogId: undefined,
          dialogLabel: t("newDialog"),
          attachedDocs: [],
          attachedImages: [],
          turnTokens: undefined,
        },
        output: "",
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
    case "/agent": {
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
      const resolvedTarget = resolveAgentSwitchTarget(argText, PLATFORM_AGENTS);
      if (!resolvedTarget) {
        return {
          nextState: state,
          output:
            `I don't know agent "${argText}" yet.\n` +
            "Use /agent, /agent list, /agent minimax-m3, or a full agent key.",
        };
      }
      return applyAgentSwitch(state, resolvedTarget);
    }
    case "/agents":
      return {
        nextState: state,
        output: renderKnownAgents(),
      };
    case "/switch": {
      if (!argText) {
        return {
          nextState: state,
          output: "Usage: /switch <agent-key|alias>  (or run /agent)",
        };
      }
      const resolvedTarget = resolveAgentSwitchTarget(argText, PLATFORM_AGENTS);
      if (!resolvedTarget) {
        return {
          nextState: state,
          output:
            `I don't know agent shortcut "${argText}" yet.\n` +
            "Use /agent, /switch nolo, /switch minimax-m3, or a full agent key.",
        };
      }
      return applyAgentSwitch(state, resolvedTarget);
    }
    case "/dialog":
      return {
        nextState: state,
        output: state.dialogId
          ? `Current dialog: ${state.dialogId}`
          : "Current dialog: new",
      };
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
