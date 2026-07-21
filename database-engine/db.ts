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

/**
 * 确保数据库处于 open 状态。
 * - 已 open / opening：直接返回
 * - 其他状态：尝试 open，一旦失败抛错
 */
export async function ensureServerDbOpen() {
  const status = authorityStore.status;
  if (status === "open") return;

  try {
    await ensureDbOpen(authorityStore);
    if (status !== "opening") {
      console.log("✅ LevelDB 已打开");
    }
  } catch (err) {
    if (isServerDbLockError(err)) {
      console.error("❌ 打开 LevelDB 失败: 数据库已被其他进程占用");
    } else {
      console.error("❌ 打开 LevelDB 失败:", err);
    }
    throw err;
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
