// core/concurrencyLimiter.ts
// 全局并发限制器：最多 N 个 task 同时在飞，超出排队。
// 用于 fire-and-forget 路径的全局背压保护（如 remote sync），
// 防止大批量 turn 的后台 promise 无限堆积打爆远端。
//
// 注意：bounded concurrency, unbounded queue — 并发数有上限但排队数
// 无上限。25k turns 的排队 task 仍会占内存（每个 pending task 持有
// closure 引用）。如果未来需要更强背压，考虑加队列上限 + 丢弃策略。

type PendingTask<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function createConcurrencyLimiter(maxConcurrent: number) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError("maxConcurrent must be a positive integer");
  }
  let active = 0;
  const pending: PendingTask<unknown>[] = [];

  function drain() {
    while (active < maxConcurrent && pending.length > 0) {
      const entry = pending.shift()!;
      active += 1;
      // H-1: 用 Promise.resolve().then() 包一层，防止 task() 同步 throw
      // 绕过 .finally() 导致 active 永不递减（slot 泄漏 → 死锁）。
      Promise.resolve()
        .then(() => entry.task())
        .then(
          (value) => entry.resolve(value),
          (error) => entry.reject(error),
        )
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push({ task, resolve, reject });
        drain();
      });
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}