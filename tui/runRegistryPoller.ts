/**
 * 本地 run registry 轮询器——停靠区的第二条数据来路，且这一条不经过模型。
 *
 * P1 之后面板仍然只有一条来路：模型调 controlAgentRun，工具返回 JSON，解析后
 * 喂给 dock。这条路决定了「面板要动，模型就得轮询」，而每次轮询都在 transcript
 * 里留下一张状态卡片——用刷屏换可见性。
 *
 * 但执行者此刻在干什么这件事，本来就写在磁盘上：`~/.nolo/runs/<runId>.json`
 * 的 `activity.inFlight` 里有 `{ kind, name, sinceMs }`。TUI 直接读就行，不需要
 * 模型、不需要网络、不花 token、不产生任何 transcript 输出。
 *
 * 有意思的是这条路比模型那条看得更细：`controlAgentRun(status)` 的返回值里
 * 压根没有 `activity` 字段，所以「正在跑 Edit，已经 3 秒」这种信息，模型自己
 * 都拿不到，只有面板拿得到。
 *
 * 轮询器不改 dock 的任何规则：它只是往 P1 已经建好的 `update()` 入口里多灌
 * 一条流，合并、linger、退休、渲染全都复用。
 */

import { type AgentRunSnapshot, readTimestamp } from "../client/agentRunSnapshot";
import type { RunRecord } from "../agentRunControl";
import {
  isAgentNameFallback,
  isAgentRunTerminalStatus,
  resolveRunLabel,
} from "../ai/tools/agent/agentRunDisplayHelpers";

/** 读一次 json 很便宜，可以贴着面板的重绘节奏走。 */
export const RUN_POLL_INTERVAL_MS = 1000;
/**
 * 记录静默多久之后才值得去问「这进程还在吗」。
 *
 * 孤儿判定走 checkStaleRun（工具路径用的同一个函数，不另写一套），而它对一个
 * 活着的进程会 fork 一次 `ps` 且是同步的——在 TUI 主线程上就是一次卡顿。所以
 * 触发条件不是「每 15 秒问一次」，而是「这条记录已经 15 秒没动静了」：健康的
 * run 每 2 秒就会把 activity 写回磁盘，永远不会触发；真正可疑的（进程被 OOM
 * 掉、崩了、没写终态就没了）第一时间就会被问到。
 */
export const RUN_RECONCILE_SILENCE_MS = 15_000;

export type RunRegistryPollerDeps = {
  /** 面板当前挂着哪些 run（dock.getRuns()）。 */
  getDockedRuns: () => AgentRunSnapshot[];
  /** 把读到的状态喂回 dock。 */
  update: (snapshot: AgentRunSnapshot) => void;
  /** 读一条 run 记录（纯文件读）。 */
  readRecord: (runId: string) => RunRecord | null | undefined;
  /** 孤儿回收：pid 没了就把记录落成终态。返回 null 表示记录不存在。 */
  reconcile?: (runId: string) => RunRecord | null | undefined;
  /**
   * 每 tick 把成功读到的记录（含刚变成终态的）广播出去。终态唤醒观察器
   * （runCompletionWatcher）挂在上面。读不到记录的 run 不在其列（可能跑在
   * 服务端，本地 registry 里根本没有）。
   */
  onRecordsPolled?: (records: RunRecord[]) => void;
  now?: () => number;
  intervalMs?: number;
  reconcileSilenceMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

export type RunRegistryPoller = {
  /** 有 run 上板时调用；已经在转、或已经 dispose 过，都什么都不做。 */
  ensureRunning(): void;
  /** 立刻走一轮（测试与首帧用）。 */
  poll(): void;
  /** 停表并忘掉去重状态；之后仍可被 ensureRunning 重新起表。 */
  stop(): void;
  /** 会话结束时调用：停表，且此后拒绝再起表。 */
  dispose(): void;
};

/**
 * RunRecord → 面板快照。
 *
 * 时间戳在 registry 里是 ISO 字符串，面板要的是 epoch millis。
 */
export function snapshotFromRunRecord(
  record: RunRecord,
  now: number
): AgentRunSnapshot {
  const label = resolveRunLabel(record);
  // 时间戳的「什么算有效」只有一份判定（readTimestamp：有限且 > 0），面板、
  // 卡片和这里共用，免得同一条记录在两个界面上一个显示年龄一个不显示。
  const startedAt = readTimestamp(record.startedAt);
  const endedAt = readTimestamp(record.endedAt);
  const activity = record.activity;
  const counters = activity?.counters;

  // inFlight.sinceMs 是「截至 activity.updatedAt 已经进行了多久」，是个采样值。
  // 换算回绝对起点后面板就能自己把秒数走下去，而不是每帧重复那个旧数字。
  let inFlight: AgentRunSnapshot["inFlight"] = null;
  const raw = activity?.inFlight;
  if (raw && !isAgentRunTerminalStatus(record.status)) {
    const updatedAt = activity?.updatedAt ? Date.parse(activity.updatedAt) : NaN;
    const base = Number.isFinite(updatedAt) ? updatedAt : now;
    const startedFrom = base - (Number.isFinite(raw.sinceMs) ? raw.sinceMs : 0);
    // 起点必须落在 (0, now] 里。坏掉的 sinceMs 或时钟回拨算出负数时，面板会把
    // 它当成 1970 年的时刻，渲染出「已进行 19900 天」；算出未来时刻则是负时长。
    // 两种都不如老老实实说「刚开始」。
    const usable =
      Number.isFinite(startedFrom) && startedFrom > 0 ? Math.min(startedFrom, now) : now;
    inFlight = { kind: raw.kind, name: raw.name, startedAt: usable };
  }

  return {
    runId: record.runId,
    status: record.status,
    ...(isAgentNameFallback(label) ? {} : { agentName: label }),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { finishedAt: endedAt } : {}),
    ...(typeof counters?.toolCalls === "number" ? { toolCallCount: counters.toolCalls } : {}),
    // note 在终态时是死因（"orphaned: process gone…"），非终态时只是备注。
    ...(record.note && isAgentRunTerminalStatus(record.status)
      ? { errorMessage: record.note }
      : {}),
    inFlight,
    logKey: "",
  };
}

/**
 * 去重指纹：只包含「变了就该重画」的字段。
 *
 * 年龄和 inFlight 的秒数都由 dock 的 tick 自己走，不进指纹——否则每秒都判定
 * 为「变了」，每个 run 每秒触发一次整块 composer 重绘，白白把重绘量翻几倍。
 */
function fingerprint(snapshot: AgentRunSnapshot): string {
  return JSON.stringify([
    snapshot.status,
    snapshot.agentName ?? "",
    snapshot.toolCallCount ?? -1,
    snapshot.errorMessage ?? "",
    snapshot.finishedAt ?? 0,
    snapshot.inFlight ? [snapshot.inFlight.kind, snapshot.inFlight.name, snapshot.inFlight.startedAt] : null,
  ]);
}

export function createRunRegistryPoller(deps: RunRegistryPollerDeps): RunRegistryPoller {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalMs ?? RUN_POLL_INTERVAL_MS;
  const reconcileSilenceMs = deps.reconcileSilenceMs ?? RUN_RECONCILE_SILENCE_MS;
  const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let timer: unknown = null;
  let disposed = false;
  const lastEmitted = new Map<string, string>();
  const lastReconciledAt = new Map<string, number>();

  const stop = () => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    lastEmitted.clear();
    lastReconciledAt.clear();
  };

  /** 记录最后一次有动静的时刻：activity 在跑就用它，否则退回 run 的起点。 */
  const freshnessOf = (record: RunRecord): number => {
    return readTimestamp(record.activity?.updatedAt) ?? readTimestamp(record.startedAt) ?? 0;
  };

  const poll = () => {
    const at = now();
    // 终态 run 不必再读：它的记录不会再变，dock 的 linger 会自己送它下板。
    const active = deps.getDockedRuns().filter(
      (run) => run.runId && !isAgentRunTerminalStatus(run.status)
    );
    if (active.length === 0) {
      // 没有活跃 run 就没有可轮询的东西。下次有 run 上板时 ensureRunning 会
      // 把表重新开起来。
      stop();
      return;
    }

    const alive = new Set<string>();
    // 本 tick 成功读到的记录：去重跳过（fingerprint 没变）不等于没读到，
    // 观察者（终态唤醒）需要看到每一条读到的记录来做自己的转变检测。
    const polled: RunRecord[] = [];
    for (const run of active) {
      alive.add(run.runId);
      // 轮询器跑在 TUI 的主循环上，任何一条 run 的读取出岔子都不该把整个界面
      // 带走。眼下注入的 readRunRecord/checkStaleRun 自己就吞掉了所有 IO 与
      // JSON 异常，这层守卫是给未来的注入者留的，不是在补今天的洞。
      let record: RunRecord | null | undefined;
      try {
        record = deps.readRecord(run.runId);
        // 记录静默太久才去问 pid 还在不在——那一步会同步 fork 一次 ps。健康的
        // run 每 2 秒写一次 activity，走不到这里；真死了的第一轮就会被问到。
        // lastReconciledAt 只是防抖：进程真没了的话记录会被落成终态，下一轮
        // 就被上面的 active 过滤掉了，不会反复问。
        if (
          deps.reconcile &&
          record &&
          !isAgentRunTerminalStatus(record.status) &&
          at - freshnessOf(record) >= reconcileSilenceMs &&
          at - (lastReconciledAt.get(run.runId) ?? 0) >= reconcileSilenceMs
        ) {
          lastReconciledAt.set(run.runId, at);
          record = deps.reconcile(run.runId) ?? record;
        }
      } catch {
        continue;
      }
      // 读不到记录不代表 run 没了：这条 run 可能跑在服务端、根本不在本地
      // registry 里。本地读不到就交给原来那条路（模型轮询），不动面板。
      if (!record) continue;
      polled.push(record);

      const snapshot = snapshotFromRunRecord(record, at);
      const mark = fingerprint(snapshot);
      if (lastEmitted.get(run.runId) === mark) continue;
      lastEmitted.set(run.runId, mark);
      deps.update(snapshot);
    }

    // 已经下板的 run 不必再占着去重表。
    for (const runId of [...lastEmitted.keys()]) {
      if (!alive.has(runId)) lastEmitted.delete(runId);
    }
    for (const runId of [...lastReconciledAt.keys()]) {
      if (!alive.has(runId)) lastReconciledAt.delete(runId);
    }

    // 观察者出岔子不该带走轮询器——它跑在 TUI 主循环上。
    if (polled.length > 0 && deps.onRecordsPolled) {
      try {
        deps.onRecordsPolled(polled);
      } catch {
        /* observer errors must not take down the poll loop */
      }
    }
  };

  return {
    ensureRunning() {
      // stop() 是可逆的（没有活跃 run 时自己停表，有新 run 再起），dispose()
      // 不是：会话都退出了，迟到的 tool-result 不该再把表开起来。
      if (disposed || timer !== null) return;
      timer = setIntervalFn(poll, intervalMs);
    },
    poll,
    stop,
    dispose() {
      disposed = true;
      stop();
    },
  };
}
