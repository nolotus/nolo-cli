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

export const ACTIVITY_FRAMES = ["·", "~", "≈", "∿", "≈", "~"];
export const ACTIVITY_FRAME_INTERVAL_MS = 150;
/** 无可见输出超过此时长（且 turn 仍活跃）时，补一行 working fallback。 */
export const ACTIVITY_FALLBACK_DELAY_MS = 1200;

export type ActivityIndicatorView = {
  frame: string;
  label: string;
  elapsedSec: number;
};

export type ActivityIndicatorDeps = {
  /** turn 是否进行中（readlineWorkspace 用 () => activeTurnAbort !== null）。 */
  isTurnActive: () => boolean;
  /** fallback 行文案，readlineWorkspace 用 () => `${state.agentName} -> working`。 */
  fallbackLabel: () => string;
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
  /** 当前应渲染的活动行数据；explicit 优先，其次 fallback，都没有返回 null。 */
  getView(): ActivityIndicatorView | null;
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

  const elapsedSecFrom = (startedAt: number) =>
    startedAt > 0 ? Math.max(0, Math.floor((now() - startedAt) / 1000)) : 0;

  const tick = () => {
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

  const getView = (): ActivityIndicatorView | null => {
    // turn 结束后 stop() 前的收尾窗口：不渲染残留活动行（abort 会跳过 finish 的 report(null)）。
    if (!deps.isTurnActive()) return null;
    const frame = ACTIVITY_FRAMES[frameIndex % ACTIVITY_FRAMES.length]!;
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
  };

  return { report, getView, stop };
}
