export type LocalDialogReadResult = {
  meta: any;
  msgs: any[];
};

/**
 * 本地库开锁等待预算（ms）。
 *
 * 刻意远小于 ensureServerDbOpen 默认的 90s：那个默认值是给**服务器部署重启**
 * 用的（要等旧进程 drain 完再接管，见 database-engine/db.ts）。本函数是 CLI /
 * TUI 只读兜底，抢锁的对手是常驻 dev server——它不会主动让出 LOCK，等 90s 和
 * 等 3s 结果一样是失败，只是白白卡住用户一分半钟。
 *
 * 快速失败后调用方仍会退回原始 HTTP 错误，诊断信息不丢。
 */
export const LOCAL_READ_LOCK_TIMEOUT_MS = 3_000;

/**
 * 本地只读兜底的开库选项。抽成纯函数是为了能直接断言这份契约
 * （短预算 + 静默），不必 mock.module 替换 db / fetchMessages —— 那种替换
 * 在同一次 bun test 进程里无法可靠还原，会打挂后续文件的用例。
 */
export function resolveLocalReadOpenOptions(lockTimeoutMs?: number): {
  timeoutMs: number;
  quiet: true;
} {
  return {
    timeoutMs: lockTimeoutMs ?? LOCAL_READ_LOCK_TIMEOUT_MS,
    // 抢不到锁是预期内的（dev server 常驻持锁），调用方会退回 HTTP 错误。
    quiet: true,
  };
}

export async function readDialogFromLocalDb(args: {
  dialogKey: string;
  dialogId: string;
  limit: number;
  /**
   * 可选的已打开 db 实例（例如 CLI authority broker 的 legacy db）。
   * 传入时直接用它读 meta 和 msgs，跳过 ensureServerDbOpen —— 因为 broker
   * 已经 open 过，且 broker 本身负责管理 LevelDB LOCK，不会和 dev server /
   * 上一轮 agent runtime 抢锁。
   * 不传时保持原行为：import serverDb + ensureServerDbOpen，向后兼容。
   *
   * 注意：当前**没有生产调用者传这个参数**（CLI 的 readDialogSnapshot 走默认
   * 分支）。它是留给 broker 接入的 seam，同时供测试注入，别误以为线上在用。
   */
  db?: any;
  /**
   * 开锁等待预算（ms），默认 LOCAL_READ_LOCK_TIMEOUT_MS。
   * 同样当前无生产调用者，仅作测试注入与将来调参的入口。
   */
  lockTimeoutMs?: number;
}): Promise<LocalDialogReadResult> {
  const [{ fetchMessages }] = await Promise.all([
    import("../chat/messages/fetchMessages"),
  ]);
  let serverDb: any;
  if (args.db) {
    // broker db 已经 open 过，不再 ensureServerDbOpen，避免直接 new Level() 抢 LOCK。
    serverDb = args.db;
  } else {
    const dbModule = await import("../database-engine/db");
    serverDb = dbModule.default;
    await dbModule.ensureServerDbOpen(
      resolveLocalReadOpenOptions(args.lockTimeoutMs)
    );
  }
  return {
    meta: await serverDb.get(args.dialogKey),
    msgs: await fetchMessages(serverDb, args.dialogId, {
      limit: args.limit,
      throwOnError: true,
    }),
  };
}
