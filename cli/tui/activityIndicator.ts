/**
 * TUI 活动行状态机（docked composer 上方的 "∿ label (Ns) · Esc to stop" 行）。
 *
 * 从 readlineWorkspace.ts 抽出，目的是把「显式活动标签 + 静默看门狗 fallback」
 * 的状态变迁变成可单测的纯逻辑。readlineWorkspace 只负责把它接到
 * fixedInput.repaint、state.agentName 和 activeTurnAbort 上。
 *
 * 两类状态：
 * - explicit label：来自 activityReporter 的具体标签（llm-start 的 "working
 *   locally"、工具调用标签）。非空时优先显示。
 * - fallback：turn 进行中（isTurnActive），但距上次 report 已超过
 *   fallbackDelayMs 且当前没有 explicit label 时自动激活。用来填补「文本流完
 *   模型在憋 tool_call」「tool-result 到下一轮 llm-start 之间」「网络卡顿」
 *   这些静默空窗——此前这些窗口活动行是全黑的，用户会误以为 turn 已结束。
 *
 * 流式输出期间 report(null) 会被每个 chunk 频繁调用，lastActivityAt 始终保持
 * 新鲜，fallback 不会触发（chunk 间隔 < fallbackDelayMs），因此不会和滚动的
 * 文本重复指示。
 */

import { resolveCliColorEnabled } from "../client/terminalStyles";
import type { AgentRunSnapshot } from "../client/agentRunSnapshot";
import {
  formatRunAge,
  getAgentRunStatusIcon,
  isAgentRunTerminalStatus,
  runShowsLogTail,
  shortRunId,
} from "../../ai/tools/agent/agentRunDisplayHelpers";
import { t } from "./i18n";
import { themeText } from "./theme";

export const ACTIVITY_FRAMES = ["·", "~", "≈", "∿", "≈", "~"];
export const ACTIVITY_FRAME_INTERVAL_MS = 150;
/** 无可见输出超过此时长（且 turn 仍活跃）时，补一行 working fallback。 */
export const ACTIVITY_FALLBACK_DELAY_MS = 1200;

export type ActivityIndicatorView = {
  frame: string;
  label: string;
  elapsedSec: number;
};

/**
 * The panel renders the same snapshot the transcript cards do — one parser,
 * one shape, so the two surfaces cannot disagree about a run's state.
 */
export type AgentRunStatusSnapshot = AgentRunSnapshot;

export type ActivityIndicatorDeps = {
  /** turn 是否进行中（readlineWorkspace 用 () => activeTurnAbort !== null）。 */
  isTurnActive: () => boolean;
  /** fallback 行文案，readlineWorkspace 用 () => `${state.agentName} -> working`。 */
  fallbackLabel: () => string;
  /** 停止中文案，readlineWorkspace 用 () => t("turnStopping")。 */
  stoppingLabel: () => string;
  /** 重绘 composer（含光标隐藏/显示与 isPaused 守卫），由调用方提供。 */
  onRepaint: () => void;
  now?: () => number;
  frameIntervalMs?: number;
  fallbackDelayMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

export type ActivityIndicator = {
  /** 外部活动上报：非空 = 具体标签；null = 标签清空（文本/工具输出正在流动）。 */
  report(label: string | null): void;
  /** 更新后台子 Agent 运行状态快照。 */
  updateAgentRun(snapshot: AgentRunStatusSnapshot): void;
  /** 清除后台子 Agent 运行状态快照。 */
  clearAgentRun(): void;
  /** 获取当前 Agent Run 快照。 */
  getAgentRun(): AgentRunStatusSnapshot | null;
  /** 当前应渲染的活动行数据；explicit 优先，其次 fallback，都没有返回 null。 */
  getView(): ActivityIndicatorView | null;
  /** 获取全套活动 Panel 渲染行（含基础活动行及贴在输入区上方的 Agent Run 状态面板）。 */
  getActivityLines(colorEnabled?: boolean): string[] | null;
  /** Esc 即时反馈：把活动行切到「停止中」文案，frame 冻结不再动。 */
  markStopping(): void;
  /** 是否已处于停止中状态（第二次 Esc 判定用）。 */
  isStopping(): boolean;
  /** turn 结束时调用：清 timer 与全部状态。 */
  stop(): void;
};

export function createActivityIndicator(
  deps: ActivityIndicatorDeps,
): ActivityIndicator {
  const now = deps.now ?? (() => Date.now());
  const frameIntervalMs = deps.frameIntervalMs ?? ACTIVITY_FRAME_INTERVAL_MS;
  const fallbackDelayMs = deps.fallbackDelayMs ?? ACTIVITY_FALLBACK_DELAY_MS;
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let explicitLabel: string | null = null;
  let explicitStartedAt = 0;
  let fallbackActive = false;
  let fallbackStartedAt = 0;
  let lastActivityAt = 0;
  let frameIndex = 0;
  let timer: unknown = null;
  // 停止中：用户按了 Esc，链路正在 unwind。冻结 frame、显示停止中文案，
  // 第二次 Esc 据此判定强制停止。stop() 必须清掉它，否则下一轮 turn 一开始
  // 就显示"停止中"。
  let stopping = false;

  const elapsedSecFrom = (startedAt: number) =>
    startedAt > 0 ? Math.max(0, Math.floor((now() - startedAt) / 1000)) : 0;

  const tick = () => {
    // 停止中：冻结 frame，只重绘（让停止中文案持续显示但不闪动）。
    // 不推进看门狗，因为用户已发起停止，无需再补 working fallback。
    if (stopping) {
      deps.onRepaint();
      return;
    }
    frameIndex += 1;
    // 看门狗：turn 活跃、无 explicit label、距上次 report 超过阈值 → 激活 fallback。
    // lastActivityAt > 0 只是防御性守卫（真实环境 Date.now() 恒 > 0）。
    if (
      explicitLabel === null &&
      !fallbackActive &&
      deps.isTurnActive() &&
      lastActivityAt > 0 &&
      now() - lastActivityAt >= fallbackDelayMs
    ) {
      fallbackActive = true;
      fallbackStartedAt = now();
    }
    deps.onRepaint();
  };

  const ensureTimer = () => {
    if (timer === null) {
      timer = setIntervalFn(tick, frameIntervalMs);
    }
  };

  const report = (label: string | null) => {
    lastActivityAt = now();
    if (label !== null) {
      explicitLabel = label;
      if (explicitStartedAt === 0) explicitStartedAt = lastActivityAt;
      fallbackActive = false;
      fallbackStartedAt = 0;
    } else {
      explicitLabel = null;
      explicitStartedAt = 0;
      fallbackActive = false;
      fallbackStartedAt = 0;
    }
    // timer 贯穿整个 turn（直到 stop()），看门狗靠它探测静默空窗。
    ensureTimer();
    // 立即重绘一次，让标签的出现/消失不必等下一个 150ms 帧。
    deps.onRepaint();
  };

  const markStopping = () => {
    stopping = true;
    // 不改 frameIndex：冻结在当前帧，让活动行不闪。
    // 不清 explicitLabel/fallbackActive：它们在 stop() 时统一清。
    // 立即重绘一帧让停止中文案显示出来，不必等下一个 150ms tick。
    deps.onRepaint();
  };

  const isStopping = () => stopping;

  const getView = (): ActivityIndicatorView | null => {
    // turn 结束后 stop() 前的收尾窗口：不渲染残留活动行（abort 会跳过 finish 的 report(null)）。
    if (!deps.isTurnActive()) return null;
    const frame = ACTIVITY_FRAMES[frameIndex % ACTIVITY_FRAMES.length]!;
    // 停止中：固定文案优先于 explicit/fallback，让用户立刻看到反馈。
    if (stopping) {
      return {
        frame,
        label: deps.stoppingLabel(),
        elapsedSec: 0,
      };
    }
    if (explicitLabel !== null) {
      return {
        frame,
        label: explicitLabel,
        elapsedSec: elapsedSecFrom(explicitStartedAt),
      };
    }
    if (fallbackActive) {
      return {
        frame,
        label: deps.fallbackLabel(),
        elapsedSec: elapsedSecFrom(fallbackStartedAt),
      };
    }
    return null;
  };

  let agentRunSnapshot: AgentRunStatusSnapshot | null = null;

  const updateAgentRun = (snapshot: AgentRunStatusSnapshot) => {
    agentRunSnapshot = snapshot;
    deps.onRepaint();
  };

  const clearAgentRun = () => {
    agentRunSnapshot = null;
    deps.onRepaint();
  };

  const getAgentRun = () => agentRunSnapshot;

  const getActivityLines = (colorEnabled = resolveCliColorEnabled()): string[] | null => {
    const lines: string[] = [];
    const baseView = getView();
    if (baseView) {
      const elapsed = Math.max(0, baseView.elapsedSec);
      const elapsedStr = `${elapsed}s`;
      const stopHint = t("stopHint");
      if (!colorEnabled) {
        lines.push(`${baseView.frame} ${baseView.label} (${elapsedStr}) · ${stopHint}`);
      } else {
        lines.push(
          themeText(baseView.frame, "accent") +
            " " +
            themeText(baseView.label, "muted") +
            themeText(` (${elapsedStr})`, "chrome") +
            themeText(` · ${stopHint}`, "chrome")
        );
      }
    }

    if (agentRunSnapshot) {
      lines.push(...formatAgentRunPanelLines(agentRunSnapshot, colorEnabled, now()));
    }

    return lines.length > 0 ? lines : null;
  };

  const stop = () => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    explicitLabel = null;
    explicitStartedAt = 0;
    fallbackActive = false;
    fallbackStartedAt = 0;
    lastActivityAt = 0;
    stopping = false;
    agentRunSnapshot = null;
  };

  return {
    report,
    updateAgentRun,
    clearAgentRun,
    getAgentRun,
    getView,
    getActivityLines,
    markStopping,
    isStopping,
    stop,
  };
}

/**
 * Progress suffix: ` · 12 tools · read, grep`. Empty when the run has not
 * reported any tool activity yet.
 */
function formatPanelProgress(snapshot: AgentRunStatusSnapshot): string {
  const parts: string[] = [];
  if (typeof snapshot.toolCallCount === "number" && Number.isFinite(snapshot.toolCallCount)) {
    parts.push(`${snapshot.toolCallCount} tools`);
  }
  if (snapshot.lastToolNames && snapshot.lastToolNames.length > 0) {
    parts.push(snapshot.lastToolNames.join(", "));
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * The run's own words beat its stdout. `lastAssistantText` is a sentence the
 * sub-agent wrote; the log tail is whatever byte sequence happened to land last
 * and is regularly a truncated JSON fragment.
 */
function formatPanelDetail(snapshot: AgentRunStatusSnapshot): string {
  const note = snapshot.lastAssistantText?.trim();
  if (note) return note;
  // The log fallback obeys the same rule as the cards (`runShowsLogTail`)
  // rather than a second one of its own: raw stdout is evidence on a failed run
  // and noise on a healthy one. Falling back unconditionally here put the very
  // `DATA_CLONE_ERR: 25,` fragments the cards now withhold straight back onto
  // the dock.
  if (!runShowsLogTail(snapshot.status)) return "";
  const lines = snapshot.logLines;
  if (!lines || lines.length === 0) return "";
  return lines[lines.length - 1]?.trim() ?? "";
}

export function formatAgentRunPanelLines(
  snapshot: AgentRunStatusSnapshot,
  colorEnabled: boolean,
  now: number = Date.now()
): string[] {
  const lines: string[] = [];
  const name = snapshot.agentName || "sub-agent";
  const short = shortRunId(snapshot.runId);
  const runId = short ? ` (${short})` : "";
  const status = snapshot.status || "running";

  // Status vocabulary comes from the run store (`done`/`failed`/`timeout`/
  // `killed`/`cancelled`), not from a guessed list — the previous local list
  // checked for `completed`/`finished`/`success`, none of which the store ever
  // emits, so a finished run kept rendering with the in-progress hourglass.
  const statusSymbol = getAgentRunStatusIcon(status);
  const statusColor: "warning" | "success" | "danger" = !isAgentRunTerminalStatus(status)
    ? "warning"
    : status === "done"
      ? "success"
      : "danger";

  const errPart = snapshot.errorMessage ? ` · ${snapshot.errorMessage}` : "";
  const progressPart = formatPanelProgress(snapshot);
  // The panel repaints on a timer, so this ticks live — unlike the transcript
  // cards, which freeze the age at the moment they were emitted.
  const age = formatRunAge(snapshot, now);
  const agePart = age ? ` · ${age}` : "";

  if (!colorEnabled) {
    lines.push(
      `🤖 Sub-Agent: ${name}${runId} · ${statusSymbol} ${status}${agePart}${progressPart}${errPart}`
    );
  } else {
    const botIcon = themeText("🤖", "accent", true);
    const labelText = themeText(" Sub-Agent: ", "muted", true);
    const nameText = themeText(`${name}${runId}`, "chrome", true);
    // agePart belongs on the coloured branch too — the real TUI runs with
    // colour on, so omitting it here made the live duration invisible in
    // exactly the mode users see.
    const statusText = themeText(` · ${statusSymbol} ${status}`, statusColor, true);
    const ageText = agePart ? themeText(agePart, "chrome") : "";
    const progressText = progressPart ? themeText(progressPart, "chrome") : "";
    const errorText = errPart ? themeText(errPart, "danger") : "";
    lines.push(`${botIcon}${labelText}${nameText}${statusText}${ageText}${progressText}${errorText}`);
  }

  const detail = formatPanelDetail(snapshot);
  if (detail) {
    if (!colorEnabled) {
      lines.push(`   └ ${detail}`);
    } else {
      lines.push(`${themeText("   └ ", "muted")}${themeText(detail, "chrome")}`);
    }
  }

  return lines;
}
