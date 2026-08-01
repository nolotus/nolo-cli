// core/keyedTaskQueue.ts
// Per-key 串行任务队列，防止同一 key 的 read-modify-write 并发覆盖（Lost Update）。
// 复用给 token stats 聚合（per userId+dateKey）、dialog token patch（per dialogKey）等。

const queues = new Map<string, Promise<unknown>>();

/**
 * 按 key 串行执行 task：同一 key 的 task 排队依次执行，不同 key 并行。
 * 返回 task 的结果。队列条目在完成后自动清理。
 *
 * 不设超时：计费写路径上 Promise.race 超时会导致"调用方以为失败但 orphan
 * task 仍写完 record"的漏扣风险。串行队列本身已解决 Lost Update；
 * IO 卡死用外部进程监控处理，不在此层防御。
 */
export async function runKeyed<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const cleanup = next.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, cleanup);
  try {
    return await next;
  } finally {
    if (queues.get(key) === cleanup) {
      queues.delete(key);
    }
  }
}