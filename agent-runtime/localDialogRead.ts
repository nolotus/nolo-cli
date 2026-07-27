export type LocalDialogReadResult = {
  meta: any;
  msgs: any[];
};

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
   */
  db?: any;
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
    await dbModule.ensureServerDbOpen();
  }
  return {
    meta: await serverDb.get(args.dialogKey),
    msgs: await fetchMessages(serverDb, args.dialogId, {
      limit: args.limit,
      throwOnError: true,
    }),
  };
}
