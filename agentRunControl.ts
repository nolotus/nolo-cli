// Local background agent run control plane.
//
// Provides a small registry under ~/.nolo/runs/ and the commands that
// manage it: ps, status, logs, stop, kill. The registry is intentionally
// simple (one json file + one log file per run) so it can be inspected
// with ordinary shell tools.

import { homedir as nodeHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as nodeFs from "node:fs";
import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from "node:child_process";
import { isCompiledBinary, resolveCliEntrypointPath } from "./cliEnvHelpers";
import { isAgentRunTerminalStatus as sharedIsAgentRunTerminalStatus } from "./ai/tools/agent/agentRunDisplayHelpers";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

import type { LocalAgentLoopEvent } from "./agent-runtime/localLoop";
export type { LocalAgentLoopEvent };

export type RunActivity = {
  lastEventAt: string;
  inFlight: { kind: "llm" | "tool"; name: string; sinceMs: number } | null;
  counters: { llmCalls: number; toolCalls: number; fileEdits: number };
  updatedAt: string;
};

export type RunStatus = "running" | "done" | "failed" | "timeout" | "killed" | "orphaned";

export type RunRecord = {
  runId: string;
  pid?: number;
  agentKey: string;
  agentName?: string;
  cwd?: string;
  msgFile?: string;
  startedAt: string;
  timeoutMs?: number;
  status: RunStatus;
  exitCode?: number;
  endedAt?: string;
  logPath: string;
  dialogId?: string;
  /**
   * Parent dialog id that spawned this run (the orchestrator's own dialog,
   * NOT the run's own dialog). Persisted at spawn time so a local TUI session
   * can filter "runs belonging to this conversation" the same way the web
   * adapter filters by parentThreadId. Optional — background runs spawned
   * outside any dialog (e.g. `nolo agent run` from a shell) leave it unset.
   */
  parentDialogId?: string;
  note?: string;
  /** Batch id for grouping related runs; auto-generated when not supplied. */
  batchId?: string;
  /** Timestamp the record was reconciled to a terminal status (orphaned). */
  reconciledAt?: string;
  /** OS-reported start time of the spawned process, when the platform exposes it. */
  processStartedAt?: string;
  activity?: RunActivity;
  /**
   * True 表示该 run 处于已被同步消费者 claim、或结果已被最终消费（终局 ack）的状态。
   *
   * 有 ackLease 且未过期时表示「有人在尝试同步读它」；ackLease 被删且 ack:true
   * 时表示「结果已正式交付，claim 从此不可再释放」。
   */
  ack?: boolean;
  /**
   * 同步消费者（controlAgentRun wait）对这条 run 的租约。
   *
   * 只有 ack 这个布尔时，claim 既没有主也没有期限：一个被 abort 孤儿化的
   * 旧 wait 稍后醒来会删掉「别人的」claim，而进程被硬杀则让 claim 永久粘在
   * 磁盘上、这条 run 的完成永远没人来收。租约把两者都关掉——release 必须
   * 出示自己的 token，过期的租约任何读者都可以视为不存在。
   */
  ackLease?: {
    /** 持有者标识；release 时不匹配则说明租约已易主，不得删除。 */
    token: string;
    /** 租约获取时刻（epoch ms）。 */
    claimedAt: number;
    /** 租约有效期（ms）；超过即视为失效，无需任何人来清理。 */
    ttlMs: number;
  };
  /** True when run does not persist a child dialog. */
  ephemeral?: boolean;
};

/**
 * Terminal run statuses. `orphaned` is a terminal status reached when a run
 * record still claims `running` but its pid no longer exists (process was
 * killed / OOM'd / crashed without writing back a terminal status).
 *
 * 跨模块一致性：此集合与共享层 `agentRunDisplayHelpers.AGENT_RUN_TERMINAL_STATUSES`
 * 是同一份真值（B/D1/T 三方均从共享层 `isAgentRunTerminalStatus` 派生）。
 * 本集合保留为 CLI RunStatus 类型的编译期约束；运行时判定委托共享层，
 * 避免两份集合漂移（reviewer 指出的"同一概念两个名字"根因）。
 */
export const RUN_TERMINAL_STATUSES = new Set<RunStatus>([
  "done",
  "failed",
  "timeout",
  "killed",
  "orphaned",
]);

export function isRunTerminalStatus(status: string | undefined): boolean {
  return sharedIsAgentRunTerminalStatus(status);
}

export type FsLike = {
  mkdirSync: typeof nodeFs.mkdirSync;
  writeFileSync: typeof nodeFs.writeFileSync;
  readFileSync: typeof nodeFs.readFileSync;
  readdirSync: typeof nodeFs.readdirSync;
  existsSync: typeof nodeFs.existsSync;
  openSync: typeof nodeFs.openSync;
  unlinkSync: typeof nodeFs.unlinkSync;
  /** Optional: enables atomic tmp+rename record publishing when present. */
  renameSync?: typeof nodeFs.renameSync;
  /** Optional: enables stale lock/temporary detection when present. */
  statSync?: typeof nodeFs.statSync;
};

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

/**
 * Signal is `string | number` because liveness probing requires the *numeric*
 * 0: Node resolves a string signal by name, and "0" is not a signal name, so
 * `kill(pid, "0")` throws ERR_UNKNOWN_SIGNAL without ever probing the process.
 */
export type KillLike = (pid: number, signal: string | number) => void;

export type SleepLike = (ms: number) => Promise<void>;
export type AgentRunControlDeps = {
  env?: EnvLike;
  homedir?: () => string;
  spawn?: SpawnLike;
  fs?: FsLike;
  kill?: KillLike;
  now?: () => Date;
  generateRunId?: () => string;
  generateBatchId?: () => string;
  sleep?: SleepLike;
  setSignalHandler?: (handler: () => void) => void;
  clearSignalHandler?: () => void;
  getProcessStartTime?: (pid: number) => Date | null | undefined;
};

export function resolveNoloHome(env?: EnvLike, homedir = nodeHomedir): string {
  const fromEnv = env?.NOLO_HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".nolo");
}

export function resolveRunsDir(env?: EnvLike, homedir = nodeHomedir): string {
  return join(resolveNoloHome(env, homedir), "runs");
}

export function resolveRunRecordPath(
  runId: string,
  env?: EnvLike,
  homedir = nodeHomedir
): string {
  return join(resolveRunsDir(env, homedir), `${runId}.json`);
}

export function resolveRunLogPath(
  runId: string,
  env?: EnvLike,
  homedir = nodeHomedir
): string {
  return join(resolveRunsDir(env, homedir), `${runId}.log`);
}

export function defaultGenerateRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${timestamp}-${random}`;
}

/**
 * Default batch id generator: `batch-<ISO>-<rand>`. Same shape as run ids so
 * the two read consistently in logs. A caller that supplies its own batchId
 * bypasses this entirely.
 */
export function defaultGenerateBatchId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `batch-${timestamp}-${random}`;
}

/**
 * Best-effort exclusive lock around a record's read-modify-write.
 *
 * tmp+rename makes a single publish atomic, but it does not arbitrate between
 * two writers: the child finalizing itself and a reconciler orphaning it can
 * both read, then both publish, and the later rename silently wins. That is
 * exactly how a record ended up with `status:orphaned` next to `exitCode:0`.
 *
 * `wx` (O_CREAT|O_EXCL) is atomic on POSIX, so only one holder exists at a
 * time. A stale lock (holder crashed mid-section) is broken after
 * LOCK_STALE_MS so a dead process can never wedge the registry permanently.
 *
 * Returns the callback's value. If the lock cannot be taken the callback still
 * runs unlocked: losing an arbitration is strictly better than dropping a
 * status update entirely.
 */
const LOCK_STALE_MS = 5_000;

/**
 * Age past which an unclaimed publish temporary is considered abandoned.
 * Generous relative to a write (microseconds) so a live publish is never
 * swept out from under its own rename.
 */
const TMP_STALE_MS = 60_000;

function withRunRecordLock<T>(
  runId: string,
  deps: AgentRunControlDeps,
  fn: () => T,
  opts: { strict?: boolean } = {},
): T | undefined {
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? (() => new Date());
  const lockPath = `${resolveRunRecordPath(runId, deps.env, deps.homedir)}.lock`;
  let held = false;
  try {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      held = true;
    } catch {
      // Contended, or stale from a crashed holder. Break it only when clearly
      // stale, so a live holder's section is never cut short.
      try {
        const stat = fs.statSync?.(lockPath);
        const ageMs = stat ? now().getTime() - stat.mtimeMs : Number.POSITIVE_INFINITY;
        if (ageMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
          held = true;
        }
      } catch {
        // Someone else won the race.
      }
    }
    // strict 模式：锁拿不到时不执行 callback，返回 undefined 让调用者知道
    // 仲裁失败。claim 必须用 strict——两个并发 wait 都裸执行读-检查-写会
    // 各自拿到 token，后者覆盖前者，但两个调用者都认为自己持有 claim。
    // 非严格模式（默认）仍裸执行：best-effort 状态更新丢仲裁好过丢更新。
    if (!held && opts.strict) return undefined;
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // best effort
      }
    }
  }
}

export function writeRunRecord(record: RunRecord, deps: AgentRunControlDeps = {}): void {
  const fs = deps.fs ?? nodeFs;
  const path = resolveRunRecordPath(record.runId, deps.env, deps.homedir);
  fs.mkdirSync(resolveRunsDir(deps.env, deps.homedir), { recursive: true });
  const payload = JSON.stringify(record, null, 2);
  // Atomic publish: a run record has two concurrent writers (the child's
  // activity heartbeat every ~2s, and any reconciler/finalizer in a TUI or
  // tool process). A plain writeFileSync is not atomic, so a reader could
  // observe a truncated file and JSON.parse would fail — readRunRecord
  // swallows that as `null`, which upstream reads as "record gone".
  // tmp + rename makes every read see either the old or the new record.
  if (typeof fs.renameSync === "function") {
    // Unique per write: two writes to the same runId from one process (the
    // heartbeat and a finalize) would otherwise share a tmp path and clobber
    // each other. The rename stays atomic either way.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, path);
      return;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
  }
  fs.writeFileSync(path, payload);
}

const FILE_EDIT_TOOL_NAMES = new Set(["writeFile", "editFile"]);
const DEFAULT_ACTIVITY_WRITE_INTERVAL_MS = 2000;

type InFlightState = {
  kind: "llm" | "tool";
  name: string;
  startMs: number;
};

export type RunActivityTracker = {
  onLoopEvent: (event: LocalAgentLoopEvent) => void;
  getActivity: () => RunActivity;
  flush: () => void;
  dispose: () => void;
};

export function createRunActivityTracker(
  runId: string,
  deps: AgentRunControlDeps = {},
  options: { minWriteIntervalMs?: number } = {}
): RunActivityTracker {
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? (() => new Date());
  const minWriteIntervalMs =
    options.minWriteIntervalMs ?? DEFAULT_ACTIVITY_WRITE_INTERVAL_MS;

  let lastEventAt = now().toISOString();
  let inFlight: InFlightState | null = null;
  const counters = { llmCalls: 0, toolCalls: 0, fileEdits: 0 };
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastWriteAt = 0;

  function serializeActivity(): RunActivity {
    const nowDate = now();
    const nowMs = nowDate.getTime();
    return {
      lastEventAt,
      inFlight: inFlight
        ? {
            kind: inFlight.kind,
            name: inFlight.name,
            sinceMs: Math.max(0, nowMs - inFlight.startMs),
          }
        : null,
      counters: { ...counters },
      updatedAt: nowDate.toISOString(),
    };
  }

  function doWrite() {
    writeTimer = undefined;
    const record = readRunRecord(runId, deps);
    if (!record) return;
    const activity = serializeActivity();
    writeRunRecord({ ...record, activity }, deps);
    lastWriteAt = now().getTime();
  }

  function scheduleWrite() {
    if (writeTimer !== undefined) return;
    const elapsed = now().getTime() - lastWriteAt;
    const delay = Math.max(0, minWriteIntervalMs - elapsed);
    writeTimer = setTimeout(doWrite, delay);
  }

  function onLoopEvent(event: LocalAgentLoopEvent) {
    lastEventAt = new Date(event.atMs).toISOString();
    switch (event.kind) {
      case "llm-start":
        inFlight = { kind: "llm", name: "llm", startMs: event.atMs };
        break;
      case "llm-end":
        inFlight = null;
        counters.llmCalls += 1;
        break;
      case "tool-start":
        inFlight = { kind: "tool", name: event.name, startMs: event.atMs };
        break;
      case "tool-end":
        inFlight = null;
        counters.toolCalls += 1;
        if (FILE_EDIT_TOOL_NAMES.has(event.name)) {
          counters.fileEdits += 1;
        }
        break;
    }
    scheduleWrite();
  }

  function getActivity() {
    return serializeActivity();
  }

  function flush() {
    doWrite();
  }

  function dispose() {
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    }
  }

  return { onLoopEvent, getActivity, flush, dispose };
}

export function readRunRecord(runId: string, deps: AgentRunControlDeps = {}): RunRecord | null {
  const fs = deps.fs ?? nodeFs;
  const path = resolveRunRecordPath(runId, deps.env, deps.homedir);
  // One retry on parse failure: with a concurrent writer, a read can land on a
  // partially written file. Callers treat `null` as "no such run", so silently
  // swallowing that would turn a torn read into a phantom disappearance.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(path, "utf8")) as RunRecord;
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

export function listRunRecords(deps: AgentRunControlDeps = {}): RunRecord[] {
  const fs = deps.fs ?? nodeFs;
  const dir = resolveRunsDir(deps.env, deps.homedir);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    const record = readRunRecord(runId, deps);
    if (record) records.push(record);
  }
  return records.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export function findRunRecordByPid(
  pid: number,
  deps: AgentRunControlDeps = {}
): RunRecord | undefined {
  return listRunRecords(deps).find((record) => record.pid === pid);
}

export function findRunRecord(
  target: string,
  deps: AgentRunControlDeps = {}
): RunRecord | undefined {
  if (/^\d+$/.test(target)) {
    const pid = Number(target);
    const byPid = findRunRecordByPid(pid, deps);
    if (byPid) return byPid;
  }
  return readRunRecord(target, deps) ?? undefined;
}

// ── List query: filter + paginate + reconcile ──────────────────────────────

/**
 * Default page size for `controlAgentRun(action:"list")` on the CLI local
 * path. The old list returned the entire registry (1000+ records) in one
 * shot and blew up caller context. A bounded default keeps reads cheap even
 * when the caller passes nothing.
 */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Upper bound on `limit` so a caller asking for a huge page can't re-trigger
 * the "blow up caller context" problem. Records beyond this are paged.
 */
export const MAX_LIST_LIMIT = 200;

export type ListRunsQuery = {
  /** Only return runs in this batch. */
  batchId?: string;
  /** Only return runs spawned by this parent dialog id. */
  parentDialogId?: string;
  /** One status, or a comma-separated list (e.g. "running,orphaned"). */
  status?: string;
  /** Max records to return; clamped to [1, MAX_LIST_LIMIT], default DEFAULT_LIST_LIMIT. */
  limit?: number;
  /** Number of records to skip before the page (offset pagination). */
  offset?: number;
};

export type ListRunsResult = {
  runs: RunRecord[];
  total: number;
  hasMore: boolean;
};

function parseStatusFilter(status?: string): Set<string> | undefined {
  if (typeof status !== "string" || status.trim() === "" || status === "all") {
    return undefined;
  }
  const parts = status
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? new Set(parts) : undefined;
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  if (floored < 1) return 1;
  return floored;
}

/**
 * Query the local run registry with filter + paginate. Lazily reconciles any
 * `running` record whose pid is gone (see `checkStaleRun`) *before* filtering
 * so a newly-orphaned run is visible with its terminal status. `total` is the
 * count of records matching the filter (after reconcile, before pagination),
 * `hasMore` signals whether the page was truncated.
 *
 * Reconcile is lazy and idempotent: a record already reconciled to `orphaned`
 * has no pid and is skipped, so repeated reads don't re-probe.
 */
export function queryRunRecords(
  query: ListRunsQuery,
  deps: AgentRunControlDeps = {}
): ListRunsResult {
  let records = listRunRecords(deps);

  // Lazy reconcile: flip dead-but-still-running records to `orphaned`.
  // Done before filtering so status=orphaned picks them up on the same call.
  records = records.map((record) =>
    record.status === "running" ? (checkStaleRun(record.runId, deps) ?? record) : record
  );

  const statusSet = parseStatusFilter(query.status);
  const batchId = typeof query.batchId === "string" && query.batchId.trim() !== "" ? query.batchId.trim() : undefined;
  const parentDialogId =
    typeof query.parentDialogId === "string" && query.parentDialogId.trim() !== ""
      ? query.parentDialogId.trim()
      : undefined;

  let filtered = records.filter((record) => {
    if (batchId && record.batchId !== batchId) return false;
    if (parentDialogId && record.parentDialogId !== parentDialogId) return false;
    if (statusSet && !statusSet.has(record.status)) return false;
    return true;
  });

  const total = filtered.length;
  const limit = clampLimit(query.limit);
  const offset =
    typeof query.offset === "number" && Number.isFinite(query.offset) && query.offset > 0
      ? Math.floor(query.offset)
      : 0;
  const sliced = filtered.slice(offset, offset + limit);
  const hasMore = offset + sliced.length < total;

  return { runs: sliced, total, hasMore };
}

// ── GC: sweep terminal records past retention ─────────────────────────────

/**
 * Retention window for terminal run records (including `orphaned`). Default
 * 7 days. Non-terminal records (`running`) are never swept — a sweep on a
 * live run would corrupt an in-flight run's registry entry.
 */
export const DEFAULT_GC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type GcRunRecordsResult = {
  swept: number;
  /** Run ids that were swept (for logging / tests). */
  sweptIds: string[];
  /** Runs retained because at least one file could not be deleted. */
  failedIds: string[];
};

function tryUnlinkFile(fs: FsLike, path: string | undefined): boolean {
  if (typeof path !== "string" || path.length === 0) return true;
  try {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ENOENT";
  }
}

/**
 * Sweep terminal run records whose `endedAt` (or `reconciledAt` for orphaned)
 * is older than `retentionMs`. Removes the `.json`, `.log`, and `.msg.md`
 * triplet from `~/.nolo/runs/`. Non-terminal records are never removed.
 *
 * Deletion order: auxiliary files (.log / .msg.md) first, index file (.json) LAST.
 * If any auxiliary file fails to unlink (e.g. EPERM/EBUSY), the index file is
 * retained so future GC passes can discover and retry sweeping this run.
 * ENOENT is treated as successful cleanup.
 *
 * Intended to be called opportunistically (e.g. on `list`), not on a timer.
 * `now` and `retentionMs` are injectable so the sweep is deterministic in
 * tests — the sweep never reads `Date.now()` directly.
 */
export function gcRunRecords(
  deps: AgentRunControlDeps = {},
  options: { retentionMs?: number } = {}
): GcRunRecordsResult {
  const fs = deps.fs ?? nodeFs;
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const retentionMs =
    typeof options.retentionMs === "number" && options.retentionMs >= 0
      ? options.retentionMs
      : DEFAULT_GC_RETENTION_MS;

  const records = listRunRecords(deps);
  const sweptIds: string[] = [];
  const failedIds: string[] = [];

  for (const record of records) {
    if (!isRunTerminalStatus(record.status)) continue;

    // Use the most recent terminal timestamp: reconciled orphans carry
    // reconciledAt; normally-ended runs carry endedAt. Fall back to startedAt
    // so a malformed-but-terminal record still ages out rather than leaking
    // forever.
    const ts = record.reconciledAt ?? record.endedAt ?? record.startedAt;
    const ageMs = nowMs - new Date(ts).getTime();
    if (!Number.isFinite(ageMs) || ageMs < retentionMs) continue;

    const jsonPath = resolveRunRecordPath(record.runId, deps.env, deps.homedir);
    const logPath = resolveRunLogPath(record.runId, deps.env, deps.homedir);
    const msgPath =
      record.msgFile ?? join(resolveRunsDir(deps.env, deps.homedir), `${record.runId}.msg.md`);

    // 1. Delete auxiliary files FIRST (.log and .msg.md)
    const logOk = tryUnlinkFile(fs, logPath);
    const msgOk = tryUnlinkFile(fs, msgPath);

    // 2. If any auxiliary file failed to delete, KEEP the .json index file
    // so future GC passes can discover and retry sweeping this run.
    if (!logOk || !msgOk) {
      failedIds.push(record.runId);
      continue;
    }

    // 3. Delete index .json file LAST
    const jsonOk = tryUnlinkFile(fs, jsonPath);
    if (jsonOk) {
      sweptIds.push(record.runId);
    } else {
      failedIds.push(record.runId);
    }
  }

  // Sweep abandoned publish temporaries. A crash between writeFileSync(tmp)
  // and renameSync leaves an orphan `.tmp` that nothing else ever removes, so
  // without this the runs dir grows unbounded. Only clearly-stale ones are
  // touched, so an in-flight publish from another process is never disturbed.
  try {
    const dir = resolveRunsDir(deps.env, deps.homedir);
    const statSync = fs.statSync;
    for (const entry of fs.readdirSync(dir)) {
      if (typeof entry !== "string" || !entry.endsWith(".tmp")) continue;
      const tmpPath = join(dir, entry);
      try {
        const stat = statSync?.(tmpPath);
        if (stat && nowMs - stat.mtimeMs <= TMP_STALE_MS) continue;
      } catch {
        continue;
      }
      tryUnlinkFile(fs, tmpPath);
    }
  } catch {
    // Sweeping temporaries is opportunistic; never fail a GC pass over it.
  }

  return { swept: sweptIds.length, sweptIds, failedIds };
}

export function stripBackgroundFlag(args: string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg === "--bg" || arg.startsWith("--bg=")) continue;
    result.push(arg);
  }
  return result;
}

/**
 * 后台子进程会以 --cwd 为工作目录重新解析参数（spawnLocalBackgroundRun）。
 * --skill 的值可以是 dbKey 也可以是 md 文件路径；是相对路径时必须按
 * 「调用者的 cwd」转成绝对路径，否则子进程在 run cwd 下找不到文件（ENOENT）。
 */
export function absolutizeSkillArgs(
  args: string[],
  baseCwd: string = process.cwd()
): string[] {
  const result: string[] = [];
  const resolveIfPath = (value: string): string => {
    if (isAbsolute(value)) return value;
    const looksLikePath = value.includes("/") || value.endsWith(".md");
    return looksLikePath ? resolve(baseCwd, value) : value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--skill" && typeof args[i + 1] === "string") {
      result.push(arg, resolveIfPath(args[i + 1]));
      i++;
      continue;
    }
    const eqMatch = arg.match(/^--skill=(.+)$/);
    if (eqMatch) {
      result.push(`--skill=${resolveIfPath(eqMatch[1])}`);
      continue;
    }
    result.push(arg);
  }
  return result;
}

/**
 * --msg-file 根治：任务内容不走调用者的本地文件。
 * 父进程已把文件内容读入内存，spawn 前快照进 nolo runs 目录
 * （~/.nolo/runs/<runId>.msg.md），子进程参数里的 --msg-file 一律改写为
 * 该快照的绝对路径——即使调用者随后移动/删除原 spec 文件，run 也不受影响。
 */
export function rewriteMsgFileArg(args: string[], messagePath: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--msg-file" && typeof args[i + 1] === "string") {
      result.push(arg, messagePath);
      i++;
      continue;
    }
    if (arg.startsWith("--msg-file=")) {
      result.push(`--msg-file=${messagePath}`);
      continue;
    }
    result.push(arg);
  }
  return result;
}

function buildAgentRunChildCommand(options: {
  rawArgs: string[];
  commandPath?: string[];
  cliEntrypointPath?: string;
  messagePath?: string;
}): { execPath: string; childArgs: string[] } {
  const execPath = process.execPath;
  const entrypoint = options.cliEntrypointPath || resolveCliEntrypointPath();
  const commandParts = options.commandPath ?? [];
  // 子进程以 run cwd 启动并重解析参数：--msg-file 改写为 nolo runs 目录里的
  // 内容快照（不依赖调用者本地文件）；--skill 相对路径按调用者 cwd 绝对化。
  let strippedArgs = stripBackgroundFlag(options.rawArgs);
  if (options.messagePath) {
    strippedArgs = rewriteMsgFileArg(strippedArgs, options.messagePath);
  }
  strippedArgs = absolutizeSkillArgs(strippedArgs);
  if (isCompiledBinary() || entrypoint === execPath) {
    return { execPath, childArgs: [...commandParts, ...strippedArgs] };
  }
  return { execPath, childArgs: [entrypoint, ...commandParts, ...strippedArgs] };
}

export async function spawnLocalBackgroundRun(
  input: {
    rawArgs: string[];
    commandPath?: string[];
    cliEntrypointPath?: string;
    agentKey: string;
    agentName?: string;
    cwd?: string;
    msgFile?: string;
    /** 已解析的任务内容；提供时会快照进 runs 目录并让子进程读快照而非原始文件。 */
    message?: string;
    timeoutMs?: number;
    /**
     * Optional batch id to group this run with siblings. When omitted a new
     * batch id is generated so every run carries one, letting callers filter
     * by batch on the read path. Persisted on the run record.
     */
    batchId?: string;
    /**
     * Parent dialog id (the orchestrator's dialog) that spawns this run.
     * Persisted on the run record so TUI can filter runs by conversation.
     */
    parentDialogId?: string;
    output: OutputLike;
  },
  deps: AgentRunControlDeps = {}
): Promise<{ runId: string; pid?: number; logPath: string; batchId: string }> {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? nodeHomedir;
  const fs = deps.fs ?? nodeFs;
  const spawn = deps.spawn ?? nodeSpawn;
  const generateRunId = deps.generateRunId ?? defaultGenerateRunId;
  const now = deps.now ?? (() => new Date());

  const runId = generateRunId();
  const batchId = input.batchId ?? (deps.generateBatchId ?? defaultGenerateBatchId)();
  const logPath = resolveRunLogPath(runId, env, homedir);
  const recordPath = resolveRunRecordPath(runId, env, homedir);
  const runsDir = resolveRunsDir(env, homedir);
  fs.mkdirSync(runsDir, { recursive: true });

  // 任务内容快照：子进程只依赖 nolo runs 目录，不依赖调用者的本地文件。
  let messagePath: string | undefined;
  if (typeof input.message === "string") {
    messagePath = join(runsDir, `${runId}.msg.md`);
    fs.writeFileSync(messagePath, input.message);
  }

  const record: RunRecord = {
    runId,
    agentKey: input.agentKey,
    ...(typeof input.agentName === "string" && input.agentName.trim() ? { agentName: input.agentName.trim() } : {}),
    cwd: input.cwd,
    ...(messagePath ? { msgFile: messagePath } : input.msgFile ? { msgFile: input.msgFile } : {}),
    startedAt: now().toISOString(),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    status: "running",
    logPath,
    batchId,
    ...(typeof input.parentDialogId === "string" && input.parentDialogId.trim()
      ? { parentDialogId: input.parentDialogId.trim() }
      : {}),
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

  const { execPath, childArgs } = buildAgentRunChildCommand({
    rawArgs: input.rawArgs,
    commandPath: input.commandPath,
    cliEntrypointPath: input.cliEntrypointPath,
    messagePath,
  });

  const childEnv: EnvLike = {
    ...env,
    NOLO_AGENT_RUN_CHILD: "1",
    NOLO_AGENT_RUN_ID: runId,
  };

  const logFd = fs.openSync(logPath, "a");
  const proc = spawn(execPath, childArgs, {
    cwd: input.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  proc.unref();

  if (typeof proc.pid === "number") {
    record.pid = proc.pid;
    const processStartedAt = (deps.getProcessStartTime ?? defaultGetProcessStartTime)(proc.pid);
    if (processStartedAt) record.processStartedAt = processStartedAt.toISOString();
    // Atomic: the child is already running and a poller may read this record
    // concurrently, so this publish must not be observable half-written.
    writeRunRecord(record, deps);
  }

  return { runId, pid: proc.pid, logPath, batchId };
}

export function ackRunRecord(
  runId: string,
  deps: AgentRunControlDeps = {}
): void {
  withRunRecordLock(runId, deps, () => {
    const record = readRunRecord(runId, deps);
    if (!record) return;
    if (record.ack) return;
    record.ack = true;
    // 终局 ack（结果已交付）没有主也没有期限——它就是终点，不该再被释放。
    delete record.ackLease;
    writeRunRecord(record, deps);
  });
}

/** 同步消费者租约的默认有效期：足够长于一次 wait，短到崩溃后能自愈。 */
export const DEFAULT_ACK_LEASE_TTL_MS = 15 * 60 * 1000;

/** 租约是否已过期（过期租约任何读者都可视为不存在，无需谁来清理）。 */
export function isAckLeaseExpired(
  lease: NonNullable<RunRecord["ackLease"]> | undefined,
  nowMs: number
): boolean {
  if (!lease) return true;
  const ttl = typeof lease.ttlMs === "number" && lease.ttlMs > 0 ? lease.ttlMs : DEFAULT_ACK_LEASE_TTL_MS;
  const claimedAt = typeof lease.claimedAt === "number" ? lease.claimedAt : 0;
  return nowMs - claimedAt >= ttl;
}

/**
 * run 记录当前是否被「有效」claim 住（供唤醒观察器判断该不该让路）。
 *
 * 终局 ack（wait 已把结果交出去）永远算数；租约则要没过期才算数——否则
 * 一次崩溃就能让这条 run 的完成永远没人来收。
 */
export function isRunRecordClaimed(
  record: Pick<RunRecord, "ack" | "ackLease"> | undefined,
  nowMs: number
): boolean {
  if (!record) return false;
  if (record.ack === true && !record.ackLease) return true;
  return !isAckLeaseExpired(record.ackLease, nowMs);
}

/**
 * 获取一份同步消费者租约，返回释放时要出示的 token；已被他人持有则返回 null。
 *
 * 为什么不是一个布尔：布尔 claim 既无主也无期限。被 abort 孤儿化的旧 wait
 * 稍后醒来会删掉后来者的 claim（「wait 了还收到通知」在窄窗口复现），而进程
 * 被硬杀则让 claim 永久粘在磁盘上（run 完成后永久静默）。token 关掉前者，
 * ttl 关掉后者。
 */
export function claimRunRecord(
  runId: string,
  deps: AgentRunControlDeps & { ttlMs?: number } = {}
): string | null {
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();
  // strict: 锁拿不到时返回 undefined → claim 失败返回 null。
  // 两个并发 wait 抢同一 run 的 claim 时，只有一个能拿到锁并写入 token，
  // 另一个直接 null 退出，不会出现「都认为自己持有 claim」的窄窗口。
  return withRunRecordLock(
    runId,
    deps,
    () => {
      const record = readRunRecord(runId, deps);
      if (!record) return null;
      if (record.ack === true && !record.ackLease) return null;
      if (!isAckLeaseExpired(record.ackLease, nowMs)) return null;
      const token = `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      record.ack = true;
      record.ackLease = {
        token,
        claimedAt: nowMs,
        ttlMs: deps.ttlMs && deps.ttlMs > 0 ? deps.ttlMs : DEFAULT_ACK_LEASE_TTL_MS,
      };
      writeRunRecord(record, deps);
      return token;
    },
    { strict: true },
  ) ?? null;
}

/**
 * 把租约升级为终局 ack：结果确实由本次 wait 交付，claim 从此不再可释放。
 * token 不匹配（租约已易主）时什么都不做。
 */
export function commitRunRecordClaim(
  runId: string,
  token: string,
  deps: AgentRunControlDeps = {}
): void {
  withRunRecordLock(runId, deps, () => {
    const record = readRunRecord(runId, deps);
    if (!record) return;
    if (record.ackLease && record.ackLease.token !== token) return;
    record.ack = true;
    delete record.ackLease;
    writeRunRecord(record, deps);
  });
}


/**
 * 释放自己持有的租约（恢复到「未被 claim」）。
 *
 * 与 claimRunRecord 配对：wait 没能把结果交出去时释放——这次同步等待放弃
 * 了，run 之后真到终态必须重新走唤醒通道，否则结果永久静默、没人来收。
 *
 * 必须出示 token：一个被 abort 孤儿化的旧 wait 可能在很久之后才醒来执行
 * finally，那时租约早已属于新的 wait，无主释放会把后来者的 claim 删掉。
 *
 * 删字段而非写 `ack: false`：ack 语义是「结果已被谁收走」，未被收走的状态就
 * 是字段不存在，磁盘上不该留一个伪值让后来的读者去分辨 false 和 undefined。
 */
export function releaseRunRecordAck(
  runId: string,
  token: string,
  deps: AgentRunControlDeps = {}
): void {
  withRunRecordLock(runId, deps, () => {
    const record = readRunRecord(runId, deps);
    if (!record) return;
    // 租约已易主或已升级为终局 ack：这次释放不是我的事，放手。
    if (!record.ackLease || record.ackLease.token !== token) return;
    delete record.ackLease;
    delete record.ack;
    writeRunRecord(record, deps);
  });
}

export function finalizeRunRecord(
  runId: string,
  update: {
    status: RunRecord["status"];
    exitCode?: number;
    dialogId?: string;
    /** Diagnostic note for callers/logs; not persisted on the run record. */
    note?: string;
  },
  deps: AgentRunControlDeps = {}
): void {
  // Same critical section as reconciliation: a real terminal status must not
  // race a concurrent orphan verdict, in either direction.
  withRunRecordLock(runId, deps, () => {
    const record = readRunRecord(runId, deps);
    if (!record) return;
    const now = deps.now ?? (() => new Date());
    record.status = update.status;
    if (typeof update.exitCode === "number") record.exitCode = update.exitCode;
    if (update.dialogId) record.dialogId = update.dialogId;
    record.endedAt = now().toISOString();
    // A self-reported terminal status is ground truth; drop any orphan verdict
    // an earlier reconciler pass may have written.
    if (record.note?.startsWith("orphaned:")) record.note = undefined;
    writeRunRecord(record, deps);
  });
}

/**
 * Returns true when `pid` no longer exists, as reported by `kill(pid, 0)`
 * throwing ESRCH. Any other throw (e.g. EPERM, meaning the process still
 * exists but is owned by another user) is treated as "still running".
 */
export function isPidGone(pid: number, deps: AgentRunControlDeps = {}): boolean {
  // Signal 0 must be passed as the *number* 0. Node treats a string signal as
  // a name lookup, and "0" is not a signal name: `process.kill(pid, "0")`
  // throws ERR_UNKNOWN_SIGNAL before it ever probes the process. That error is
  // not ESRCH, so this function used to report every pid — dead or alive — as
  // "not gone", making liveness detection inert.
  const kill = deps.kill ?? ((p, s) => process.kill(p, s as NodeJS.Signals));
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH";
  }
}

/**
 * Attempts to retrieve process start time for a PID via `ps` CLI tool.
 * Returns null if unsupported (Windows / ps missing / process not found).
 */
export function defaultGetProcessStartTime(pid: number): Date | null {
  try {
    const output = nodeExecFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    if (!output) return null;
    const d = new Date(output);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export const MAX_PROCESS_START_TIME_DIFF_MS = 30_000;
// macOS `ps -o lstart` 只精确到秒（不含毫秒），四舍五入可能造成 ±1s 偏差；
// 加上进程 spawn 到记录写入之间的调度延迟，1s 容差会把「刚启动的活进程」
// 误判为 pid reused → orphaned（活进程被提前判死）。放宽到 2s 覆盖最坏情况：
// 秒级四舍五入（±1s）+ 记录写入延迟（<1s）。宁可多容忍 1s 的 pid 复用误判
// （概率极低），也绝不把活进程误判为孤儿。
const MAX_PERSISTED_PROCESS_START_TIME_DIFF_MS = 2_000;

/**
 * How long a run must be silent before a dead-pid inference may orphan it.
 *
 * The child writes `activity.updatedAt` at least every
 * DEFAULT_ACTIVITY_WRITE_INTERVAL_MS (2s) while it works. A heartbeat newer
 * than this window proves the process was alive far more recently than any
 * `ps`/`kill` inference, so the inference is treated as a transient probe
 * failure rather than evidence of death.
 *
 * Deliberately several multiples of the write interval: a genuinely dead
 * process stops writing and is still reclaimed a few seconds later, while a
 * busy-but-alive one is never falsely reclaimed.
 */
export const ORPHAN_HEARTBEAT_GRACE_MS = 10_000;

/** Parse an ISO timestamp to epoch ms; null when absent or unparseable. */
function readTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validates process start time against the run record's `startedAt` timestamp.
 * Returns true if the PID exists but belongs to a different process (PID reuse).
 * If start time cannot be fetched (fallback path), returns false (NEVER misjudge live process as dead).
 */
export function isPidReused(
  pid: number,
  expectedStartedAt: string,
  deps: AgentRunControlDeps = {},
  maxDiffMs = MAX_PROCESS_START_TIME_DIFF_MS
): boolean {
  const getStartTime = deps.getProcessStartTime ?? defaultGetProcessStartTime;
  const procStartTime = getStartTime(pid);
  if (!procStartTime) {
    // Fallback path: platform or test cannot fetch process start time.
    // Safe degradation rule: NEVER misjudge a living process as dead.
    return false;
  }
  const recordTime = new Date(expectedStartedAt).getTime();
  if (isNaN(recordTime)) return false;

  const diffMs = Math.abs(procStartTime.getTime() - recordTime);
  return diffMs > maxDiffMs;
}

/**
 * If a run record claims to be running and carries a pid, verify the pid is
 * still alive via `kill(pid, 0)` and matches the process start time (`startedAt`).
 * When the pid is gone (ESRCH) or the pid was reused by an unrelated process,
 * mark the record as `orphaned` — a terminal status meaning the process died
 * without writing back its own terminal status (killed / OOM / crashed). The pid
 * is cleared on the record to prevent pid-reuse false positives. Returns the
 * (possibly refreshed) record.
 *
 * EPERM (process exists but owned by another user) is treated as still
 * running — never misjudged as dead.
 */
export function checkStaleRun(
  runId: string,
  deps: AgentRunControlDeps = {}
): RunRecord | null {
  const record = readRunRecord(runId, deps);
  if (!record) return null;
  if (record.status !== "running") return record;
  if (typeof record.pid !== "number") return record;

  const pidGone = isPidGone(record.pid, deps);
  // New records persist the OS-reported process start time at spawn. Legacy
  // records fall back to run startedAt with a tolerance for spawn/ps precision.
  const expectedStartedAt = record.processStartedAt ?? record.startedAt;
  const maxStartTimeDiffMs = record.processStartedAt
    ? MAX_PERSISTED_PROCESS_START_TIME_DIFF_MS
    : MAX_PROCESS_START_TIME_DIFF_MS;
  const pidReused =
    !pidGone && isPidReused(record.pid, expectedStartedAt, deps, maxStartTimeDiffMs);

  if (!pidGone && !pidReused) return record;

  const now = deps.now ?? (() => new Date());

  // Liveness beats forensics. `pidGone`/`pidReused` are indirect inferences
  // from `kill(pid,0)` and `ps -o lstart`, both of which can transiently fail
  // (fork under load, EINTR, ps timeout, a truncated record read losing the
  // pid). The activity heartbeat is *direct* evidence: only the run's own
  // process writes it, so a recent heartbeat means the process was alive more
  // recently than this inference. Trusting the inference over the heartbeat is
  // what let live runs be marked orphaned while they kept working for minutes.
  const heartbeatAt = readTimestampMs(record.activity?.updatedAt);
  if (heartbeatAt !== null) {
    const silentMs = now().getTime() - heartbeatAt;
    if (silentMs < ORPHAN_HEARTBEAT_GRACE_MS) return record;
  }

  // Re-read immediately before the destructive write. The record may have been
  // finalized by its own process (done/failed) between our first read and now;
  // writing our stale copy would resurrect it as `orphaned` and clobber the
  // real exit status. This is why records existed with both `status:orphaned`
  // and a live `endedAt`/`exitCode:0`.
  // The re-read and the write must be one critical section. Without the lock,
  // the child could publish `done`/`exitCode:0` between them and this stale
  // copy would rename right over it — reproducing the very corruption this
  // change exists to fix.
  return withRunRecordLock(runId, deps, () => {
    const latest = readRunRecord(runId, deps);
    if (!latest) return record;
    if (latest.status !== "running") return latest;
    if (latest.activity?.updatedAt !== record.activity?.updatedAt) return latest;

    const at = now().toISOString();
    latest.status = "orphaned";
    latest.note = pidReused
      ? "orphaned: process gone (pid reused by another process)"
      : "orphaned: process gone without writing terminal status";
    latest.endedAt = at;
    latest.reconciledAt = at;
    // Clear pid: once dead, it can be reused by the OS for an unrelated
    // process. Keeping it would let a future read-path reconcile mistake the
    // recycled pid for a still-alive run (false "running"). Clearing pins the
    // terminal status.
    latest.pid = undefined;
    writeRunRecord(latest, deps);
    return latest;
  });
}

function formatDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, end - start);
  const seconds = Math.floor(elapsedMs / 1000) % 60;
  const minutes = Math.floor(elapsedMs / 60000) % 60;
  const hours = Math.floor(elapsedMs / 3600000);
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function readLastLogLines(logPath: string, count: number, deps: AgentRunControlDeps): string[] {
  const fs = deps.fs ?? nodeFs;
  try {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } catch {
    return [];
  }
}

function readLogContent(logPath: string, tailCount: number | undefined, deps: AgentRunControlDeps): string {
  const fs = deps.fs ?? nodeFs;
  try {
    const content = fs.readFileSync(logPath, "utf8");
    if (typeof tailCount === "number" && tailCount > 0) {
      const lines = content.split("\n");
      // Drop trailing empty segment from final newline so slice counts real lines.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return `${lines.slice(-tailCount).join("\n")}\n`;
    }
    return content;
  } catch {
    return "";
  }
}

const RUNNING_STATUSES: ReadonlySet<RunRecord["status"]> = new Set(["running"]);

function isRunningStatus(status: RunRecord["status"]): boolean {
  return RUNNING_STATUSES.has(status);
}

function parseJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  let json = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--json=")) {
      const value = arg.slice("--json=".length);
      json = value === "" || value === "true" || value === "1";
      continue;
    }
    rest.push(arg);
  }
  return { json, rest };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAgentPsCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const { json } = parseJsonFlag(args);
  const records = listRunRecords(deps);
  // Apply stale-pid reconciliation for any running records that carry a pid.
  for (const record of records) {
    if (record.status === "running" && typeof record.pid === "number") {
      checkStaleRun(record.runId, deps);
    }
  }
  // Re-read after reconciliation so the printed/json state reflects any updates.
  const refreshed = records
    .map((r) => readRunRecord(r.runId, deps))
    .filter(Boolean) as RunRecord[];
  if (json) {
    deps.output.write(JSON.stringify(refreshed) + "\n");
    return 0;
  }
  if (refreshed.length === 0) {
    deps.output.write("No local runs found.\n");
    return 0;
  }
  deps.output.write("RUN ID                          STATUS   PID      AGENT\n");
  for (const record of refreshed) {
    const pid = record.pid?.toString() ?? "-";
    deps.output.write(
      `${record.runId.padEnd(32)} ${record.status.padEnd(8)} ${pid.padEnd(8)} ${record.agentKey}\n`
    );
  }
  return 0;
}

function parseStatusArgs(args: string[]): {
  target: string;
  json: boolean;
  watch: boolean;
  intervalMs: number;
} {
  let target = "";
  let json = false;
  let watch = false;
  let intervalMs = 2000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--json=")) {
      const value = arg.slice("--json=".length);
      json = value === "" || value === "true" || value === "1";
      continue;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg.startsWith("--watch=")) {
      const value = arg.slice("--watch=".length);
      watch = value === "" || value === "true" || value === "1";
      continue;
    }
    if (arg === "--interval-ms") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        intervalMs = Number(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--interval-ms=")) {
      const value = arg.slice("--interval-ms=".length);
      if (/^\d+$/.test(value)) intervalMs = Number(value);
      continue;
    }
    if (!arg.startsWith("-") && !target) {
      target = arg;
    }
  }
  return { target, json, watch, intervalMs };
}

function printStatusTick(record: RunRecord, deps: AgentRunControlDeps & { output: OutputLike }): void {
  const elapsed = formatDuration(record.startedAt, record.endedAt);
  const note = record.note ? ` (${record.note})` : "";
  deps.output.write(
    `[${new Date().toISOString()}] ${record.runId} status=${record.status} elapsed=${elapsed}${note}\n`
  );
}

export async function runAgentStatusCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const { target, json, watch, intervalMs } = parseStatusArgs(args);
  if (!target) {
    deps.output.write("Usage: nolo agent status <runId|pid> [--json] [--watch] [--interval-ms N]\n");
    return 1;
  }
  const initial = findRunRecord(target, deps);
  if (!initial) {
    deps.output.write(`Run not found: ${target}\n`);
    return 1;
  }

  // Reconcile stale pids before producing output.
  const reconciled = checkStaleRun(initial.runId, deps) ?? initial;

  if (json) {
    const record = readRunRecord(reconciled.runId, deps) ?? reconciled;
    deps.output.write(JSON.stringify(record) + "\n");
    return 0;
  }

  if (!watch) {
    const record = readRunRecord(reconciled.runId, deps) ?? reconciled;
    return printStatusOnce(record, deps);
  }

  return runStatusWatch(reconciled.runId, intervalMs, deps);
}

function formatActivitySummary(activity: RunActivity | undefined): string | undefined {
  if (!activity) return undefined;
  const { counters, inFlight, lastEventAt } = activity;
  const parts: string[] = [`${counters.fileEdits} edits, ${counters.toolCalls} tools`];
  if (inFlight) {
    const elapsedSec = Math.floor(
      (Date.now() - new Date(lastEventAt).getTime()) / 1000
    );
    parts.push(`in-flight ${inFlight.kind}${inFlight.name ? ` ${inFlight.name}` : ""} ${elapsedSec}s`);
  }
  return `activity: ${parts.join(", ")}`;
}

function printStatusOnce(record: RunRecord, deps: AgentRunControlDeps & { output: OutputLike }): number {
  deps.output.write(`runId:    ${record.runId}\n`);
  deps.output.write(`status:   ${record.status}\n`);
  deps.output.write(`pid:      ${record.pid ?? "-"}\n`);
  deps.output.write(`agent:    ${record.agentKey}\n`);
  deps.output.write(`cwd:      ${record.cwd ?? "-"}\n`);
  deps.output.write(`started:  ${record.startedAt}\n`);
  deps.output.write(`elapsed:  ${formatDuration(record.startedAt, record.endedAt)}\n`);
  if (record.endedAt) deps.output.write(`ended:    ${record.endedAt}\n`);
  if (typeof record.exitCode === "number") deps.output.write(`exitCode: ${record.exitCode}\n`);
  if (record.dialogId) deps.output.write(`dialog:   ${record.dialogId}\n`);
  if (record.note) deps.output.write(`note:     ${record.note}\n`);
  const activitySummary = formatActivitySummary(record.activity);
  if (activitySummary) deps.output.write(`${activitySummary}\n`);
  deps.output.write(`log:      ${record.logPath}\n`);

  const logLines = readLastLogLines(record.logPath, 20, deps);
  if (logLines.length > 0) {
    deps.output.write("\n--- last log lines ---\n");
    for (const line of logLines) {
      deps.output.write(`${line}\n`);
    }
  }
  return 0;
}

async function runStatusWatch(
  runId: string,
  intervalMs: number,
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  let stopped = false;
  const setSignalHandler = deps.setSignalHandler ?? ((handler: () => void) => {
    process.once("SIGINT" as NodeJS.Signals, handler);
  });
  const clearSignalHandler = deps.clearSignalHandler ?? (() => {
    process.removeAllListeners("SIGINT");
  });

  setSignalHandler(() => {
    stopped = true;
  });

  try {
    let record = readRunRecord(runId, deps);
    if (!record) {
      deps.output.write(`Run not found: ${runId}\n`);
      return 1;
    }
    // Initial tick.
    printStatusTick(record, deps);
    while (!stopped && isRunningStatus(record.status)) {
      await sleep(intervalMs);
      if (stopped) break;
      record = checkStaleRun(runId, deps);
      if (!record) {
        deps.output.write(`Run not found: ${runId}\n`);
        return 1;
      }
      printStatusTick(record, deps);
    }
    if (stopped) {
      deps.output.write(`watch stopped by signal\n`);
    }
    return 0;
  } finally {
    clearSignalHandler();
  }
}

function parseLogsArgs(
  args: string[],
  onTail: (count: number) => void
): string {
  let runId = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tail") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        onTail(Number(next));
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--tail=")) {
      const value = arg.slice("--tail=".length);
      if (/^\d+$/.test(value)) onTail(Number(value));
      continue;
    }
    if (!arg.startsWith("-") && !runId) {
      runId = arg;
    }
  }
  return runId;
}

export async function runAgentLogsCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  let tailCount: number | undefined;
  const runId = parseLogsArgs(args, (count) => {
    tailCount = count;
  });
  if (!runId) {
    deps.output.write("Usage: nolo agent logs <runId> [--tail N]\n");
    return 1;
  }
  const record = readRunRecord(runId, deps) ?? findRunRecordByPid(Number(runId), deps);
  if (!record) {
    deps.output.write(`Run not found: ${runId}\n`);
    return 1;
  }
  const fs = deps.fs ?? nodeFs;
  if (!fs.existsSync(record.logPath)) {
    deps.output.write(`Log not found: ${record.logPath}\n`);
    return 1;
  }
  const content = readLogContent(record.logPath, tailCount, deps);
  deps.output.write(content);
  return 0;
}

async function runSignalCommand(
  args: string[],
  signal: "SIGTERM" | "SIGKILL",
  verb: string,
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const target = args[0];
  if (!target) {
    deps.output.write(`Usage: nolo agent ${verb} <runId|pid>\n`);
    return 1;
  }
  const record = findRunRecord(target, deps);
  if (!record) {
    deps.output.write(`Run not found: ${target}\n`);
    return 1;
  }
  if (typeof record.pid !== "number") {
    deps.output.write(`Run has no pid: ${record.runId}\n`);
    return 1;
  }
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig as NodeJS.Signals));
  try {
    kill(record.pid, signal);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") {
      deps.output.write(`Process ${record.pid} already exited.\n`);
    } else {
      deps.output.write(`Failed to ${verb} ${record.runId}: ${error}\n`);
      return 1;
    }
  }
  finalizeRunRecord(record.runId, { status: "killed" }, deps);
  deps.output.write(`Sent ${signal} to ${record.runId} (pid ${record.pid}).\n`);
  return 0;
}

export async function runAgentStopCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  return runSignalCommand(args, "SIGTERM", "stop", deps);
}

export async function runAgentKillCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  return runSignalCommand(args, "SIGKILL", "kill", deps);
}
