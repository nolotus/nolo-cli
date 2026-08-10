/**
 * 后台 run 停靠区（composer 上方那块固定的「执行者状态」面板）。
 *
 * 从 activityIndicator 里抽出来，因为面板此前有三个和编排场景直接冲突的限制：
 *
 * 1. 只存一个 snapshot。编排是 fan-out，两个以上执行者会互相覆盖，面板只剩
 *    最后一次 tool-result 提到的那个 run。
 * 2. 绑在 turn 上（activityIndicator.stop() 顺手清掉 snapshot）。可后台 run
 *    恰恰活得比 turn 长——turn 一结束面板就空了，而这正是用户最想看状态的时候。
 * 3. 只在 tool-result 到达时才更新，也就是说「动态」完全依赖模型去轮询
 *    controlAgentRun：模型不轮询面板就冻住，模型轮询 transcript 就被状态卡片
 *    刷屏。dock 自带 tick，年龄会自己走，把「刷屏换可见性」这笔交易解开。
 *
 * dock 的 timer 独立于 activityIndicator 的 turn timer：有 run 就转，run 全部
 * 消失才停，所以它能跨 turn、也能在用户正在打字时继续跳。
 *
 * 数据仍然只走 agentRunSnapshot.ts 这一个解析器——面板和 transcript 卡片共用
 * 一个 shape，两个界面不可能对同一个 run 的状态各说各话。
 */

import type { AgentRunSnapshot } from "../client/agentRunSnapshot";
import {
  clipText,
  formatRunAge,
  getAgentRunStatusIcon,
  isAgentRunTerminalStatus,
  shortRunId,
} from "../../ai/tools/agent/agentRunDisplayHelpers";
import { formatAgentRunPanelLines } from "./agentRunPanelLines";
import { activeInFlight, formatInFlightFact, runStatusTone } from "./runSnapshotDisplay";
import { themeText } from "./theme";

/** 年龄每秒走一格；比 150ms 的活动帧慢，因为这里没有动画只有秒数。 */
export const RUN_DOCK_TICK_INTERVAL_MS = 1000;
/** 终态 run 在面板上多留一会，让用户看到「结束」这一帧而不是凭空消失。 */
export const RUN_DOCK_LINGER_MS = 8_000;
/**
 * 超过这个时长没收到任何更新就把 run 摘掉。没有它，一个我们已经失去跟踪的
 * run（模型不再轮询、进程静默死亡）会让 dock 永远转下去并一直显示 running。
 * P2 的本地 registry 轮询上线后每秒都会刷新 updatedAt，这条基本不会触发。
 */
export const RUN_DOCK_STALE_MS = 5 * 60_000;
/** 同时展开的 run 行数上限；面板吃的是 scroll region，必须有硬顶。 */
export const RUN_DOCK_MAX_ROWS = 3;
/** 记住多少个已退休的 runId，用来挡住对已完成 run 的持续轮询。 */
const RETIRED_MEMORY = 64;

export type RunDockDeps = {
  /** 重绘 composer（含光标隐藏/显示与 isPaused 守卫），由调用方提供。 */
  onRepaint: () => void;
  now?: () => number;
  tickIntervalMs?: number;
  lingerMs?: number;
  staleMs?: number;
  maxRows?: number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

export type RunDock = {
  /** 合并一条 run 快照（按 runId）。not_found 视为摘除。 */
  update(snapshot: AgentRunSnapshot): void;
  /** 摘掉一条 run。 */
  remove(runId: string): void;
  /** 清空面板。 */
  clear(): void;
  /** 当前面板上的 run，活跃在前、同组按首次出现顺序。 */
  getRuns(): AgentRunSnapshot[];
  /** 渲染行；空面板返回 []。 */
  getLines(colorEnabled: boolean): string[];
  /** 会话结束时调用：停 timer 并清空。 */
  dispose(): void;
};

type DockEntry = {
  snapshot: AgentRunSnapshot;
  /** 首次出现顺序，用来在同组内保持稳定排序。 */
  seq: number;
  updatedAt: number;
  /** 进入终态的时刻，linger 计时用；非终态为 null。 */
  terminalAt: number | null;
};

/**
 * 后一条快照只覆盖它真正带了的字段。
 *
 * 快照是用条件展开构造的（缺失字段直接不存在，而不是 undefined），所以一次
 * 只报 status 的轮询不会把 startAgentRun 带来的 taskPreview / startedAt 抹掉。
 *
 * errorMessage 是唯一的例外，因为它是唯一「会被撤回」的字段：一次瞬时错误
 * （重试中的 ETIMEDOUT）之后，恢复正常的轮询根本不带这个 key，粘住的话面板
 * 会给一个健康的 run 一直挂着红字。run 一旦进终态，错误就是结论，留住。
 */
function mergeSnapshot(prev: AgentRunSnapshot, next: AgentRunSnapshot): AgentRunSnapshot {
  const merged = { ...prev, ...next };
  if (
    merged.errorMessage &&
    next.errorMessage === undefined &&
    !isAgentRunTerminalStatus(merged.status)
  ) {
    delete merged.errorMessage;
  }
  // inFlight 的三个值各有各的意思：对象 = 此刻在做这件事；null = 我刚看过，
  // 它空着（工具刚跑完、还没进下一个）；undefined = 这个来源根本不知道。
  // 只有本地 registry 轮询报得出前两者，模型那条路永远是 undefined，所以
  // 一次模型轮询不该把轮询器刚读到的动作抹掉。
  if (next.inFlight === undefined) {
    if (prev.inFlight !== undefined) merged.inFlight = prev.inFlight;
  }
  return merged;
}

export function createRunDock(deps: RunDockDeps): RunDock {
  const now = deps.now ?? (() => Date.now());
  const tickIntervalMs = deps.tickIntervalMs ?? RUN_DOCK_TICK_INTERVAL_MS;
  const lingerMs = deps.lingerMs ?? RUN_DOCK_LINGER_MS;
  const staleMs = deps.staleMs ?? RUN_DOCK_STALE_MS;
  const maxRows = deps.maxRows ?? RUN_DOCK_MAX_ROWS;
  const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  const entries = new Map<string, DockEntry>();
  /**
   * linger 走完、已经从面板上退休的终态 runId。
   *
   * 没有它，编排 agent 对一个已完成的 run 继续轮询（截图里就是这么跑的）会让
   * 它以「新 run」的身份重新插回来，terminalAt 重置、linger 重新计时——已结束
   * 的 run 于是每 8 秒「消失一次又冒出来一次」，永远退不掉。
   *
   * 只收终态退休的 run：因为 stale 摘掉的 run 未必真的结束了，它后面要是又开始
   * 报状态，说明我们只是短暂失联，应该让它重新上板。
   */
  const retired = new Set<string>();
  let seqCounter = 0;
  let timer: unknown = null;
  let disposed = false;

  const stopTimer = () => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  /** 摘掉已经 linger 到期的终态 run 和失联太久的 run。返回是否有变化。 */
  const prune = (): boolean => {
    const at = now();
    let changed = false;
    for (const [runId, entry] of entries) {
      const expiredTerminal = entry.terminalAt !== null && at - entry.terminalAt >= lingerMs;
      const stale = at - entry.updatedAt >= staleMs;
      if (!expiredTerminal && !stale) continue;
      entries.delete(runId);
      changed = true;
      if (expiredTerminal) {
        retired.add(runId);
        // 退休名单是防重生用的，不是历史档案；留个上限免得长会话里无限涨。
        if (retired.size > RETIRED_MEMORY) {
          const oldest = retired.values().next().value;
          if (oldest !== undefined) retired.delete(oldest);
        }
      }
    }
    // 面板清空了就该停表——不管是谁触发的 prune。此前只有 tick() 检查这件事，
    // 于是从 getLines() 里摘掉最后一条 run 后，timer 还会空转一格。
    if (entries.size === 0) stopTimer();
    return changed;
  };

  const tick = () => {
    prune();
    deps.onRepaint();
  };

  const ensureTimer = () => {
    if (timer === null && entries.size > 0) {
      timer = setIntervalFn(tick, tickIntervalMs);
    }
  };

  const update = (snapshot: AgentRunSnapshot) => {
    // 会话已经退出：迟到的 tool-result 不该把 dock 复活，更不该重开一个往
    // 已经不归自己管的终端上重绘的 timer。
    if (disposed) return;
    const runId = snapshot.runId;
    // 没有 runId 就无法合并也无法去重；这种事件对面板没有意义。
    if (!runId) return;
    // 服务端已经不认识这个 run 了：摘掉，而不是挂一条 `? not_found` 在那。
    if (snapshot.status === "not_found") {
      remove(runId);
      return;
    }
    // 已经退休的终态 run：模型还在轮询它，但用户已经看过结果了。
    if (retired.has(runId)) return;

    const at = now();
    const prev = entries.get(runId);
    const merged = prev ? mergeSnapshot(prev.snapshot, snapshot) : snapshot;
    const terminal = isAgentRunTerminalStatus(merged.status);
    entries.set(runId, {
      snapshot: merged,
      seq: prev ? prev.seq : seqCounter++,
      updatedAt: at,
      // terminalAt 只在首次进入终态时记一次：终态 run 后续还会被轮询到，
      // 每次都刷新的话 linger 永远走不完，面板会一直挂着已完成的 run。
      terminalAt: terminal ? (prev?.terminalAt ?? at) : null,
    });
    ensureTimer();
    deps.onRepaint();
  };

  const remove = (runId: string) => {
    if (!entries.delete(runId)) return;
    if (entries.size === 0) stopTimer();
    deps.onRepaint();
  };

  const clear = () => {
    if (entries.size === 0) return;
    entries.clear();
    stopTimer();
    deps.onRepaint();
  };

  /** 活跃在前、终态在后，组内按首次出现顺序。 */
  const orderedEntries = (): DockEntry[] =>
    [...entries.values()].sort((a, b) => {
      const aTerminal = a.terminalAt !== null ? 1 : 0;
      const bTerminal = b.terminalAt !== null ? 1 : 0;
      if (aTerminal !== bTerminal) return aTerminal - bTerminal;
      return a.seq - b.seq;
    });

  const getRuns = () => orderedEntries().map((entry) => entry.snapshot);

  const getLines = (colorEnabled: boolean): string[] => {
    // 读也顺手 prune：终端可能在两次 tick 之间就要重绘（比如按键），
    // 这时不该把一条已经该消失的 run 再画一帧。
    prune();
    const ordered = orderedEntries();
    if (ordered.length === 0) return [];
    const at = now();
    // 单条 run 保持原来的两行形态（含 `└ detail`）：绝大多数会话只有一个
    // 执行者，没必要为了多 run 的表头牺牲它的信息量。
    if (ordered.length === 1) {
      return formatAgentRunPanelLines(ordered[0]!.snapshot, colorEnabled, at);
    }
    return formatRunDockLines(
      ordered.map((entry) => entry.snapshot),
      colorEnabled,
      at,
      maxRows
    );
  };

  return {
    update,
    remove,
    clear,
    getRuns,
    getLines,
    dispose() {
      disposed = true;
      entries.clear();
      retired.clear();
      stopTimer();
    },
  };
}

/** `2 running · 1 done · 1 failed` —— 活跃合并计数，终态按状态词分组。 */
function summarize(snapshots: AgentRunSnapshot[]): string {
  let running = 0;
  const terminal = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (!isAgentRunTerminalStatus(snapshot.status)) {
      running += 1;
      continue;
    }
    terminal.set(snapshot.status, (terminal.get(snapshot.status) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  for (const [status, count] of terminal) parts.push(`${count} ${status}`);
  return parts.join(" · ");
}

/**
 * 多 run 形态：一行表头 + 每条 run 一行 + 溢出行。
 *
 * 每条 run 严格一行（不带 detail 子行）：面板占的是 scroll region 的高度，
 * 三个执行者各带一条日志尾巴就能吃掉半屏历史。
 */
export function formatRunDockLines(
  snapshots: AgentRunSnapshot[],
  colorEnabled: boolean,
  now: number = Date.now(),
  maxRows: number = RUN_DOCK_MAX_ROWS
): string[] {
  // 空面板没有表头可言。getLines() 已经拦了这一路，但这个函数是导出的，
  // 直接调用它的人不该拿到一行 `🤖 runs · `。
  if (snapshots.length === 0) return [];
  const lines: string[] = [];
  const summary = summarize(snapshots);
  const header = `🤖 runs · ${summary}`;
  lines.push(colorEnabled ? themeText(header, "muted", true) : header);

  const shown = snapshots.slice(0, Math.max(1, maxRows));
  for (const snapshot of shown) {
    lines.push(formatRunDockRow(snapshot, colorEnabled, now));
  }

  const hidden = snapshots.length - shown.length;
  if (hidden > 0) {
    const more = `  +${hidden} more`;
    lines.push(colorEnabled ? themeText(more, "chrome") : more);
  }
  return lines;
}

/** `  ⏳ AGY Flash #26f2ye · 6m12s · 24 tools · Edit 3s` */
function formatRunDockRow(
  snapshot: AgentRunSnapshot,
  colorEnabled: boolean,
  now: number
): string {
  const name = snapshot.agentName || "sub-agent";
  const short = shortRunId(snapshot.runId);
  const icon = getAgentRunStatusIcon(snapshot.status);
  const terminal = isAgentRunTerminalStatus(snapshot.status);
  const statusColor = runStatusTone(snapshot.status);

  const facts: string[] = [];
  const age = formatRunAge(snapshot, now);
  // 终态行把状态词写出来（`done 42s`）：图标区分得了成功失败，区分不了
  // killed 和 timeout，而那两个的处理方式完全不同。
  if (terminal) facts.push(age ? `${snapshot.status} ${age}` : snapshot.status);
  else if (age) facts.push(age);
  if (typeof snapshot.toolCallCount === "number" && Number.isFinite(snapshot.toolCallCount)) {
    facts.push(`${snapshot.toolCallCount} tools`);
  }
  // 「此刻在做什么」压过「最后做过什么」：前者由本地 registry 轮询提供且带
  // 自己的计时，后者只是历史。终态 run 没有此刻，直接跳过。
  const inFlight = activeInFlight(snapshot);
  if (inFlight) {
    facts.push(formatInFlightFact(inFlight, now));
  } else {
    // 退而求其次：最后一个工具名。多 run 行宽有限，全列出来会把 run 名挤掉。
    const lastTool = snapshot.lastToolNames?.[snapshot.lastToolNames.length - 1];
    if (lastTool) facts.push(clipText(lastTool, 20));
  }
  if (snapshot.errorMessage) facts.push(clipText(snapshot.errorMessage, 40));

  const label = `${name}${short ? ` #${short}` : ""}`;
  const factsPart = facts.length > 0 ? ` · ${facts.join(" · ")}` : "";
  if (!colorEnabled) return `  ${icon} ${label}${factsPart}`;

  const errorTail = snapshot.errorMessage;
  return (
    themeText("  ", "chrome") +
    themeText(icon, statusColor, true) +
    " " +
    themeText(label, "chrome", true) +
    themeText(factsPart, errorTail ? "danger" : "chrome")
  );
}
