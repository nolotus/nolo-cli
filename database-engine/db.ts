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
  /** 锁错误重试总预算（ms）。默认从 env NOLO_SERVER_DB_OPEN_LOCK_TIMEOUT_MS 读，缺省 90000（必须 > drain 预算 30s） */
  timeoutMs?: number;
  /** 相邻两次重试的间隔（ms），默认 1000 */
  intervalMs?: number;
  /** 可注入的 sleep 实现，测试用 */
  sleep?: (ms: number) => Promise<void>;
  /** 可注入的时钟，测试用 */
  now?: () => number;
};

const DEFAULT_SERVER_DB_OPEN_LOCK_TIMEOUT_MS = 90_000;
const DEFAULT_SERVER_DB_OPEN_LOCK_INTERVAL_MS = 1_000;

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

  const timeoutMs = options?.timeoutMs ?? resolveServerDbOpenLockTimeoutMs();
  const intervalMs =
    options?.intervalMs ?? DEFAULT_SERVER_DB_OPEN_LOCK_INTERVAL_MS;
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? Date.now;

  const deadline = now() + timeoutMs;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await ensureDbOpen(authorityStore);
      if (status !== "opening") {
        console.log("✅ LevelDB 已打开");
      }
      return;
    } catch (err) {
      if (!isServerDbLockError(err)) {
        console.error("❌ 打开 LevelDB 失败:", err);
        throw err;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        console.error("❌ 打开 LevelDB 失败: 数据库已被其他进程占用");
        throw err;
      }
      console.warn(
        `⚠️ LevelDB 被其他进程占用（第 ${attempt} 次尝试，距超时约 ${Math.max(1, Math.ceil(remainingMs / 1000))}s），${intervalMs}ms 后重试`
      );
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
  const status = authorityStore.status;
  if (status !== "open") return;

  try {
    await authorityStore.close();
    console.log("✅ LevelDB 已关闭");
  } catch (err) {
    console.error("❌ 关闭 LevelDB 失败:", err);
  }
}
