// 文件路径: packages/database/server/db.ts

import { isLevelLockError } from "../database/levelLockError";
import { ensureDbOpen } from "./ensureDbOpen";
import { resolveServerDbPath } from "./dbPath";
import type { LegacyServerDb } from "./legacyServerDb";
import type { AuthorityStore } from "./authorityStoreTypes";
import { getOrCreateServerStoreRuntime } from "./serverStoreFactory";

const DB_PATH = resolveServerDbPath();

console.log("数据库配置:");
console.log("- 当前工作目录:", process.cwd());
console.log("- 数据库路径:", DB_PATH);

/**
 * Walk cause / AggregateError chains and detect LevelDB lock/busy via the
 * shared pure seam. Kept here so migration scripts and server open paths
 * keep a single exported name without pulling pure detection into db init.
 */
export function isServerDbLockError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (isLevelLockError(current)) return true;

    if ((current as any)?.cause) queue.push((current as any).cause);
    if (Array.isArray((current as any)?.errors)) {
      queue.push(...(current as any).errors);
    }
  }

  return false;
}

/**
 * Blue-green two-phase drain: thrown when ensureServerDbOpen() is called
 * after markServerDbShuttingDown(). Phase-2 in-flight streams that try to
 * (re)open the DB get this tagged error instead of silently reacquiring the
 * LevelDB file lock (which would steal it back from the canary process).
 */
export class ServerDbShuttingDownError extends Error {
  readonly code = "SERVER_DB_SHUTTING_DOWN" as const;
  // advisory-only：现有调用方检查 isLevelLifecycleError（匹配 LEVEL_*_NOT_OPEN），
  // 不消费此字段。保留是为了未来可能的 shutdown-aware retry 逻辑。
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "ServerDbShuttingDownError";
  }
}

const {
  authorityStore,
  serverDb,
}: { authorityStore: AuthorityStore; serverDb: LegacyServerDb } =
  getOrCreateServerStoreRuntime(DB_PATH);

console.log("- LevelDB实际路径:", serverDb.location);

// ✅ 保留默认导出：兼容现有的 import serverDb from "./db"
export default serverDb;

// 具名导出：需要的时候可以引用
export { serverDb };
export function getServerAuthorityStore() {
  return authorityStore;
}

export type ServerDbOpenRetryOptions = {
  /**
   * 锁错误重试总预算（ms）。默认从 env NOLO_SERVER_DB_OPEN_LOCK_TIMEOUT_MS 读，
   * 缺省 8000 —— 这是「快速失败」预算，不是「等旧进程 drain 完」预算。
   * 为什么不需要覆盖 drain 的 30s：见 DEFAULT_SERVER_DB_OPEN_LOCK_TIMEOUT_MS 的说明。
   */
  timeoutMs?: number;
  /** 相邻两次重试的间隔（ms），默认 1000 */
  intervalMs?: number;
  /** 可注入的 sleep 实现，测试用 */
  sleep?: (ms: number) => Promise<void>;
  /** 可注入的时钟，测试用 */
  now?: () => number;
  /**
   * 静默重试日志。用于 CLI/TUI 的只读兜底：抢不到锁是预期内的常见情况，
   * 逐秒打 warn 只会刷屏（一次失败刷 90 行），且调用方会退回更有用的
   * HTTP 错误。服务器启动路径保持默认 false —— 那里的等待需要可观测。
   */
  quiet?: boolean;
};

/**
 * 抢锁预算。旧值 90s 是「等旧进程 drain 完」的悲观上限，但它把一次**失败的进程交接**
 * 变成了 90 秒静默重试：新进程每秒 warn 一次却不退出，PM2 认为它还活着，
 * 于是要么旧进程仍在服务（部署静默失败、新代码从未上线），
 * 要么旧进程已死（服务真空，且超过 Caddy 的 60s lb_try_duration，用户看到硬失败）。
 *
 * 实测（生产机，独立实例）：父子进程结构下 kill 漏掉持锁进程时，
 * 新进程连续重试 82s 仍未启动，而外部探针全程 200 —— 故障完全不可见。
 *
 * 正常交接只需毫秒级（实测 close 2ms / open 15ms），drain 已不再无条件等待，
 * 所以这里改为 8s：足够覆盖一次正常交接的抖动，又能在真正卡住时**快速失败**，
 * 让进程退出 → PM2 重启 → 异常可见，而不是静默耗尽整个部署窗口。
 *
 * ⚠️ 安全前提（改动前必读）：8s < drain 预算 30s，这个值只有在
 * **新进程启动时旧进程已经关完 DB** 的前提下才安全。该前提由
 * `scripts/release/deployRemote.sh` 的 rebuild_nolo 时序保证：
 *     delete_nolo_and_wait → wait_for_leveldb_lock_release → start_nolo
 * 即先等旧进程退出并确认 LOCK 无持有者，才拉起新进程。
 * 若future 有人把 start_nolo 提到 wait_for_leveldb_lock_release 之前
 * （例如为了「预热重叠」让新旧进程并行），本预算必须同步上调到 > drain 上限，
 * 否则新进程会在旧进程正常 drain 期间被误判为抢锁失败而反复重启。
 */
const DEFAULT_SERVER_DB_OPEN_LOCK_TIMEOUT_MS = 8_000;
// 100ms 轮询：蓝绿部署时 canary 等旧进程释放 LevelDB 锁，
// 锁释放后平均等 50ms 而非 500ms，减少 canary /ready 延迟。
// 25ms 轮询：这个间隔直接进部署窗口——旧进程释放锁到 canary 拿到锁之间，
// 平均要等半个间隔。100ms → 25ms 把这一项从平均 50ms 降到 ~12ms。
// 抢锁失败是廉价的 open() 尝试，25ms 的重试频率对 8s 预算不构成压力。
const DEFAULT_SERVER_DB_OPEN_LOCK_INTERVAL_MS = 25;

/**
 * Shutdown flag：两阶段 drain 在 phase 1 释放 LevelDB 锁后，
 * phase 2 的在途流可能调用 ensureServerDbOpen() 懒加载重新打开 DB。
 * 这会重新获取 LevelDB 文件锁——把刚释放给 canary 的锁抢回来，
 * 导致 canary 等锁超时 + 旧进程被 PM2 SIGKILL。
 * 设置此 flag 后 ensureServerDbOpen() 拒绝重新打开，抛出 tagged retryable 错误。
 *
 * 可重置：--hot 模块热替换和 desktop restart 会复用同一进程，
 * 新的 bootstrapServer 调用 clearServerDbShuttingDown() 重置此 flag。
 */
let serverDbShuttingDown = false;

export function markServerDbShuttingDown() {
  serverDbShuttingDown = true;
}

export function clearServerDbShuttingDown() {
  serverDbShuttingDown = false;
}

function resolveServerDbOpenLockTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.NOLO_SERVER_DB_OPEN_LOCK_TIMEOUT_MS;
  if (!raw) return DEFAULT_SERVER_DB_OPEN_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SERVER_DB_OPEN_LOCK_TIMEOUT_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保数据库处于 open 状态。
 * - 已 open / opening：直接返回
 * - 其他状态：尝试 open；锁错误（LEVEL_LOCKED / Resource temporarily unavailable）
 *   在 deadline 内有界重试，等待旧进程 drain 释放 LevelDB LOCK，避免部署重启
 *   时的崩溃循环；非锁错误立即抛出。
 */
export async function ensureServerDbOpen(options?: ServerDbOpenRetryOptions) {
  const status = authorityStore.status;
  if (status === "open") return;

  // 蓝绿两阶段 drain：phase 1 已关闭 DB 并释放锁，phase 2 的在途流
  // 不能重新打开 DB（会抢回 canary 正在等的 LevelDB 锁）。
  // 抛出 tagged retryable 错误，让调用方知道这是 shutdown 期间的可重试状态。
  if (serverDbShuttingDown) {
    throw new ServerDbShuttingDownError(
      "Server DB is shutting down (blue-green phase 2 drain); cannot reopen LevelDB"
    );
  }

  const timeoutMs = options?.timeoutMs ?? resolveServerDbOpenLockTimeoutMs();
  const intervalMs =
    options?.intervalMs ?? DEFAULT_SERVER_DB_OPEN_LOCK_INTERVAL_MS;
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? Date.now;

  const deadline = now() + timeoutMs;
  // -Infinity 而不是 0：注入时钟的测试从 t=0 起步，用 0 会把**第一条**警告吞掉——
  // 而第一条恰恰是最该出现的（「开始等锁了」）。
  let lastLockWarnAt = Number.NEGATIVE_INFINITY;

  for (let attempt = 1; ; attempt += 1) {
    // Retry loop 内也要 recheck：canary 等锁期间如果收到 shutdown 信号
    // （虽然正常流程不会发生，但防止 race），不再继续尝试打开。
    if (serverDbShuttingDown) {
      throw new ServerDbShuttingDownError(
        "Server DB shutdown signaled during lock retry; aborting reopen"
      );
    }
    try {
      await ensureDbOpen(authorityStore);
      if (status !== "opening" && !options?.quiet) {
        console.log("✅ LevelDB 已打开");
      }
      return;
    } catch (err) {
      if (!isServerDbLockError(err)) {
        if (!options?.quiet) console.error("❌ 打开 LevelDB 失败:", err);
        throw err;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        if (!options?.quiet) {
          // 抢锁超时几乎总是「上一个进程没退干净」，而不是磁盘/权限问题。
          // 打印可直接执行的排查线索，避免只留一行无从下手的报错。
          console.error(
            `❌ 打开 LevelDB 失败: 锁被其他进程持有，已重试 ${attempt} 次 / ${timeoutMs}ms。` +
              ` 通常是上一个 server 进程未完全退出（注意父子进程树），` +
              ` 排查：fuser -v ${authorityStore.location ?? "<dbPath>"}/LOCK`
          );
        }
        throw err;
      }
      // 25ms 重试意味着 90s 预算下最多 3600 次；每次都打一行会把部署日志淹掉。
      // 按秒聚合：信息量（还在等、还剩多久）一点没少，行数回到 ~90。
      if (!options?.quiet && now() - lastLockWarnAt >= 1_000) {
        lastLockWarnAt = now();
        console.warn(
          `⚠️ LevelDB 被其他进程占用（已尝试 ${attempt} 次，距超时约 ${Math.max(1, Math.ceil(remainingMs / 1000))}s），${intervalMs}ms 后继续`
        );
      }
      await sleep(intervalMs);
    }
  }
}

/**
 * 兼容入口调用：启动时显式 open 一次
 */
export async function openServerDb() {
  return ensureServerDbOpen();
}

/**
 * 优雅关机时关闭 DB
 */
export async function closeServerDb() {
  // 先标记 shutdown：即使 DB 不在 open 状态（如刚启动就 shutdown），
  // 也要阻止后续 ensureServerDbOpen 重新打开。
  // 放在 status check 之前，确保所有路径都设 flag。
  markServerDbShuttingDown();

  // WARNING D 修复：如果 DB 正在 opening（phase-2 懒加载 ensureDbOpen 在途），
  // 等它离开 opening 状态再决定是否关闭。否则 open 完成后 DB 持有锁但不会被关闭。
  for (let i = 0; i < 50; i++) {
    const s = authorityStore.status;
    if (s !== "opening") break;
    await defaultSleep(100);
  }

  const status = authorityStore.status;
  if (status !== "open") return;

  try {
    await authorityStore.close();
    console.log("✅ LevelDB 已关闭");
  } catch (err) {
    console.error("❌ 关闭 LevelDB 失败:", err);
  }
}
