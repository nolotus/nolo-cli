export type LocalDialogReadResult = {
  meta: any;
  msgs: any[];
};

export async function readDialogFromLocalDb(args: {
  dialogKey: string;
  dialogId: string;
  limit: number;
}): Promise<LocalDialogReadResult> {
  const [{ default: serverDb, ensureServerDbOpen }, { fetchMessages }] = await Promise.all([
    import("../database-engine/db"),
    import("../chat/messages/fetchMessages"),
  ]);
  await ensureServerDbOpen();
  return {
    meta: await serverDb.get(args.dialogKey),
    msgs: await fetchMessages(serverDb, args.dialogId, {
      limit: args.limit,
      throwOnError: true,
    }),
  };
}
