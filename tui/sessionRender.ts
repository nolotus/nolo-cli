import { resolveCliColorEnabled } from "../client/terminalStyles";
import {
  formatTokenCount,
  renderTokenStatus,
  type TurnTokenUsage,
} from "../client/tokenUsage";
import { DEFAULT_TUI_AGENT_KEY, resolveCatalogPlatformAgents } from "./agentCatalog";
import { renderDialogTitle } from "./dialogFrame";
import { t } from "./i18n";
import { displayWidth } from "./readlineWorkspace";
import { stripAnsi } from "./tuiAnsi";
import {
  themeText,
  themeColorSequence,
  surfaceBackgroundSequence,
  resolveTuiBrightness,
} from "./theme";
import { getProcessRegistry } from "../agent-runtime/processRegistry";
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
export function renderComposerTokenChip(
  tokens: TurnTokenUsage | undefined,
  fallbackContextWindow?: number,
  estimatedContextTokens?: number,
) {
  const cw = tokens?.contextWindow ?? fallbackContextWindow;
  if (!cw) {
    return "context: —";
  }
  // Prefer provider usage; otherwise show the measured system+tools estimate.
  const used = tokens
    ? tokens.input + tokens.output
    : Math.max(0, estimatedContextTokens ?? 0);
  const pct = Math.min(100, (used / cw) * 100);
  const pctText = pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  return `context: ${pctText}% (${formatTokenCount(used)}/${formatTokenCount(cw)})`;
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
  // runtime-mode 为默认的 auto 时不显示——它是默认值，纯噪声，且会与 auto
  // 路由名叠成 "auto · auto"。只有显式切到 local / server 才值得占一个 chip。
  const modeSuffix =
    state.modeLabel && state.modeLabel !== "auto"
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

  const tokenSegment = themeText(
    renderComposerTokenChip(
      state.turnTokens,
      state.contextWindow,
      state.estimatedContextTokens,
    ),
    "muted",
    colorEnabled,
  );
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

// ── Scene builders for the welcome screen ──────────────────────────────────────────────
//
// Vertical landscape: mountain (left) → sky (right) → ground → NOLO → waves.
// All glyphs are common BMP (no emoji/PUA/Nerd Font).

function buildPlainScene(isDark: boolean, frame: number = 0, maxFrames: number = 0): string {
  let skyLine = `                      ${isDark ? "🌙" : "☀"}`;
  if (isDark) {
    const star1 = frame % 6 < 3 ? "✦" : "⋆";
    const star2 = frame % 4 < 2 ? "⋆" : "·";
    const star3 = frame % 5 < 2 ? "·" : "✦";
    skyLine = `      ${star1}               🌙    ${star2}    ${star3}`;
  }

  const wavePattern = "_.~^~.";
  const longWave = wavePattern.repeat(10);
  const offset = frame % wavePattern.length;
  const wave = longWave.slice(offset, offset + 25);

  return [
    skyLine,
    "             ╱╲                     █▄ █ ▄▀▀▄ █    ▄▀▀▄",
    "            ╱  ╲  ╱╲                █ ▀█ █  █ █    █  █",
    "           ╱    ╲╱  ╲               ▀  ▀  ▀▀  ▀▀▀▀  ▀▀",
    `          ╱  ♠       ╲          ${wave}`,
    "   ▁▁▁▁▁▁╱ ♠   ♠      ╲▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁",
  ].join("\n");
}

function buildColoredScene(isDark: boolean, frame: number = 0, maxFrames: number = 0): string {
  const pk = themeColorSequence("chrome");    // mountain + ground
  const sk = themeColorSequence("warning");   // moon / sun
  const tr = themeColorSequence("success");   // trees
  const wv = themeColorSequence("info");      // waves
  const ac = themeColorSequence("accent");    // NOLO wordmark
  const mu = themeColorSequence("muted");     // faded trailing colors
  const r  = "\x1b[39m";
  const b  = "\x1b[1m";
  const rs = "\x1b[0m";

  let skyLine = `                      ${sk}${isDark ? "🌙" : "☀"}${r}`;
  if (isDark) {
    const star1 = frame % 6 < 3 ? "✦" : "⋆";
    const star2 = frame % 4 < 2 ? "⋆" : "·";
    const star3 = frame % 5 < 2 ? "·" : "✦";
    skyLine = `      ${mu}${star1}${r}               ${sk}🌙${r}    ${mu}${star2}${r}    ${mu}${star3}${r}`;
  }

  const wavePattern = "_.~^~.";
  const longWave = wavePattern.repeat(10);
  const offset = frame % wavePattern.length;
  const wave = longWave.slice(offset, offset + 25);
  // Fade out the last 5 characters
  const waveStr = `${wv}${wave.slice(0, 20)}${r}${mu}${wave.slice(20, 25)}${r}`;

  const line1 = "█▄ █ ▄▀▀▄ █    ▄▀▀▄";
  const line2 = "█ ▀█ █  █ █    █  █";
  const line3 = "▀  ▀  ▀▀  ▀▀▀▀  ▀▀";
  
  const sweepEndFrame = maxFrames > 3 ? maxFrames - 3 : maxFrames;
  const sweepLen = maxFrames === 0 ? 21 : Math.min(21, Math.floor((frame / sweepEndFrame) * 21));
  
  const colorLine = (str: string, bold: boolean) => {
    const active = str.slice(0, sweepLen);
    const dimmed = str.slice(sweepLen);
    return `${bold ? b : ""}${ac}${active}${r}${mu}${dimmed}${r}${bold ? rs : ""}`;
  };

  const nolo1 = colorLine(line1, true);
  const nolo2 = colorLine(line2, false);
  const nolo3 = colorLine(line3, false);

  return [
    skyLine,
    `             ${pk}╱╲${r}                     ${nolo1}`,
    `            ${pk}╱  ╲  ╱╲${r}                ${nolo2}`,
    `           ${pk}╱    ╲╱  ╲${r}               ${nolo3}`,
    `          ${pk}╱${r}  ${tr}♠${r}       ${pk}╲${r}          ${waveStr}`,
    `   ${pk}▁▁▁▁▁▁╱${r} ${tr}♠${r}   ${tr}♠${r}      ${pk}╲▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁${r}`,
  ].join("\n");
}

export function renderWelcome(
  state: TuiState,
  frame: number = 0,
  maxFrames: number = 0,
  columns?: number,
) {
  const colorEnabled = resolveCliColorEnabled();
  const brightness = resolveTuiBrightness();
  const isDark = brightness === "dark";

  let sceneArt = colorEnabled
    ? buildColoredScene(isDark, frame, maxFrames)
    : buildPlainScene(isDark, frame, maxFrames);

  // The scene art is ~48 columns wide. On a narrower terminal its rows wrap,
  // which looks broken and (for the old animated banner) corrupted the redraw.
  // When we know the width and it can't hold the widest scene row, drop the
  // scene entirely and keep just the version + hint lines, which degrade to a
  // clean two-line welcome. `columns` is optional so pure-function callers and
  // tests that don't pass it keep the full scene.
  if (typeof columns === "number" && columns > 0) {
    const widestSceneCol = sceneArt
      .split("\n")
      .reduce((max, line) => Math.max(max, displayWidth(stripAnsi(line))), 0);
    if (columns < widestSceneCol) sceneArt = "";
  }

  const versionLine = colorEnabled
    ? `\x1b[1m${themeColorSequence("accent")}nolo\x1b[0m ${state.cliVersion ?? ""} | server ${state.serverUrl}`.replace("  |", " |")
    : `nolo ${state.cliVersion ?? ""} | server ${state.serverUrl}`.replace("  |", " |");

  const body = sceneArt
    ? [sceneArt, versionLine, t("welcomeHint"), ""]
    : [versionLine, t("welcomeHint"), ""];
  return body.join("\n");
}

export function renderPrompt(_state: TuiState) {
  return t("promptLabel");
}

// ─── Info panels ────────────────────────────────────────────────────────────

export function renderTuiHelp(colorEnabled = resolveCliColorEnabled()) {
  const text = t("helpText");
  if (!colorEnabled) {
    return text;
  }
  const lines = text.split("\n");
  const commandRegex = /^(\s+)(\/\S+(?:\s+\S+)*?)(\s{2,})(.+)$/;
  const sectionRegex = /^\S.+[:：]$/;
  return lines
    .map((line) => {
      if (!line.trim()) {
        return line;
      }
      if (sectionRegex.test(line)) {
        return renderDialogTitle(line, colorEnabled);
      }
      const match = line.match(commandRegex);
      if (match) {
        const [, indent, cmd, spacing, desc] = match;
        return `${indent}${themeText(cmd, "accent", colorEnabled)}${spacing}${themeText(desc, "muted", colorEnabled)}`;
      }
      return themeText(line, "muted", colorEnabled);
    })
    .join("\n");
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

  const labels = [
    t("contextFieldAgent"),
    t("contextFieldTokens"),
    t("contextFieldDialog"),
    t("contextFieldDocs"),
    t("contextFieldSkills"),
    t("contextFieldProfile"),
    t("contextFieldRuntime"),
    t("contextFieldTools"),
    t("contextFieldThinking"),
    t("contextFieldServer"),
  ];

  let maxW = 0;
  for (const l of labels) {
    const w = displayWidth(l);
    if (w > maxW) maxW = w;
  }
  const targetWidth = maxW >= 9 ? maxW + 1 : 9;

  const padLabel = (raw: string) => {
    const w = displayWidth(raw);
    const padding = " ".repeat(Math.max(0, targetWidth - w));
    return raw + padding;
  };

  const field = (rawLabel: string, value: string) =>
    `${themeText(padLabel(rawLabel), "muted", colorEnabled)}${value}`;
  const next = (command: string, description: string) =>
    `  ${themeText(command, "accent", colorEnabled)}${themeText(description, "muted", colorEnabled)}`;

  const titleText = t("contextTitle");
  const heading = colorEnabled
    ? [renderDialogTitle(titleText, true)]
    : [titleText, "─".repeat(displayWidth(titleText))];
  return [
    ...heading,
    field(labels[0], `${state.agentName} (${state.agentKey})`),
    field(labels[1], renderTokenStatus(state.turnTokens)),
    field(
      labels[2],
      state.dialogKey ?? (state.dialogId ? "unavailable" : state.dialogLabel),
    ),
    field(labels[3], docs),
    field(labels[4], skills),
    field(labels[5], state.profileName),
    field(labels[6], state.runtimeMode),
    field(labels[7], state.toolDisplay),
    field(labels[8], state.thinkingDisplay),
    field(labels[9], state.serverUrl),
    "",
    themeText(t("contextNext"), "chrome", colorEnabled),
    next("/agents            ", `  ${t("contextNextAgents")}`),
    next("/doc attach <doc>  ", `  ${t("contextNextDoc")}`),
    next("/skill attach <ref>", `  ${t("contextNextSkill")}`),
    next("/new               ", `  ${t("contextNextNew")}`),
  ].join("\n");
}

export function renderKnownAgents(colorEnabled = resolveCliColorEnabled()) {
  return [
    renderDialogTitle(t("agentsTitle"), colorEnabled),
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
      t("agentsTip"),
      "muted",
      colorEnabled,
    ),
  ].join("\n");
}
