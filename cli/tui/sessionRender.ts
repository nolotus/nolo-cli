import { resolveCliColorEnabled } from "../client/terminalStyles";
import {
  formatTokenCount,
  renderTokenStatus,
  type TurnTokenUsage,
} from "../client/tokenUsage";
import { DEFAULT_TUI_AGENT_KEY, resolveCatalogPlatformAgents } from "./agentCatalog";
import { renderDialogTitle } from "./dialogFrame";
import { t } from "./i18n";
import {
  themeText,
  themeColorSequence,
  surfaceBackgroundSequence,
} from "./theme";
import { getProcessRegistry } from "../../agent-runtime/processRegistry";
import type { TuiState } from "./sessionTypes";

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatCwd(cwd: string) {
  const parts = cwd.split(/[/\\]/);
  return parts.pop() || cwd;
}

export function formatElapsedSeconds(totalSeconds: number): string {
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

// ─── Status line ────────────────────────────────────────────────────────────

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

// ─── Welcome & prompt ───────────────────────────────────────────────────────

export function renderWelcome(state: TuiState) {
  const colorEnabled = resolveCliColorEnabled();

  // Block-character "nolo" wordmark. Three-tier gradient: line 1 bold accent,
  // line 2 accent, line 3 chrome. Uses only U+2580–U+259F block elements so it
  // renders on any monospace terminal without a patched Nerd Font.
  const logoLine1 = "█▄ █ ▄▀▀▄ █    ▄▀▀▄";
  const logoLine2 = "█ ▀█ █  █ █    █  █";
  const logoLine3 = "▀  ▀  ▀▀  ▀▀▀▀  ▀▀";

  const logoArt = colorEnabled
    ? [
        `\x1b[1m${themeColorSequence("accent")}${logoLine1}\x1b[0m`,
        themeText(logoLine2, "accent", colorEnabled),
        themeText(logoLine3, "chrome", colorEnabled),
      ].join("\n")
    : [logoLine1, logoLine2, logoLine3].join("\n");

  // Brand name in accent within the version line — no extra line needed.
  const versionLine = colorEnabled
    ? `\x1b[1m${themeColorSequence("accent")}nolo\x1b[0m ${state.cliVersion ?? ""} | server ${state.serverUrl}`.replace("  |", " |")
    : `nolo ${state.cliVersion ?? ""} | server ${state.serverUrl}`.replace("  |", " |");

  return [
    logoArt,
    versionLine,
    t("welcomeHint"),
    "",
  ].join("\n");
}

export function renderPrompt(_state: TuiState) {
  return t("promptLabel");
}

// ─── Info panels ────────────────────────────────────────────────────────────

export function renderTuiHelp() {
  return t("helpText");
}

/**
 * `/context` and `/agents` are the two panels a user reads most often, and they
 * were the last plain-text surfaces left in the TUI — an ASCII `-----` rule and
 * one flat foreground, while every dialog next to them was already themed.
 *
 * They now borrow the dialog frame's own title treatment (renderDialogTitle)
 * rather than re-inventing a heading style, and split label/value across the
 * muted/default tokens so the eye lands on the values. Layout, field order and
 * wording are unchanged: only color and one alignment fix.
 */
export function renderContextPanel(
  state: TuiState,
  colorEnabled = resolveCliColorEnabled(),
) {
  const docs = state.attachedDocs.length
    ? state.attachedDocs.join(", ")
    : "none";
  const skills = state.attachedSkills.length
    ? state.attachedSkills.join(", ")
    : "none";
  // Every label pads to display width 9 so the values line up in one column.
  // `skills` used to carry two spaces instead of three, which shunted its value
  // one column left of the other ten rows. `配置` is two CJK cells (width 4)
  // plus five spaces, which is why it looks shorter in source than it renders.
  const field = (label: string, value: string) =>
    `${themeText(label, "muted", colorEnabled)}${value}`;
  const next = (command: string, description: string) =>
    `  ${themeText(command, "accent", colorEnabled)}${themeText(description, "muted", colorEnabled)}`;
  // In color mode the accent+bold title asserts the panel boundary on its own,
  // so the old ASCII rule is gone. Piped / NO_COLOR output has no bold to lean
  // on, though, and dropping the rule there left the title running straight
  // into the fields — so plain mode keeps a rule, drawn with box-drawing rather
  // than hyphens to match the rest of the TUI's chrome.
  const heading = colorEnabled
    ? [renderDialogTitle("Workspace context", true)]
    : ["Workspace context", "─".repeat(17)];
  return [
    ...heading,
    field("agent    ", `${state.agentName} (${state.agentKey})`),
    field("tokens   ", renderTokenStatus(state.turnTokens)),
    field(
      "dialog   ",
      state.dialogKey ?? (state.dialogId ? "unavailable" : state.dialogLabel),
    ),
    field("docs     ", docs),
    field("skills   ", skills),
    field("配置     ", state.profileName),
    field("runtime  ", state.runtimeMode),
    field("tools    ", state.toolDisplay),
    field("thinking ", state.thinkingDisplay),
    field("render   ", state.renderDisplay),
    field("server   ", state.serverUrl),
    "",
    themeText("Next:", "chrome", colorEnabled),
    next("/agents            ", "  see specialist shortcuts"),
    next("/doc attach <doc>  ", "  add working context"),
    next("/skill attach <ref>", "  attach a skill to this workspace"),
    next("/new               ", "  start a clean dialog"),
  ].join("\n");
}

export function renderKnownAgents(colorEnabled = resolveCliColorEnabled()) {
  return [
    renderDialogTitle("Agents:", colorEnabled),
    ...resolveCatalogPlatformAgents().map(
      (agent, index) =>
        `  ${themeText(String(index + 1), "chrome", colorEnabled)}  ${themeText(
          agent.name.padEnd(11),
          "accent",
          colorEnabled,
        )} ${themeText(agent.description ?? "", "muted", colorEnabled)}`
    ),
    "",
    themeText(
      "Tip: run /switch for the full picker, or /switch list for your private agents too.",
      "muted",
      colorEnabled,
    ),
  ].join("\n");
}
