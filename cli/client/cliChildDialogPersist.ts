/**
 * CLI local child-dialog persistence helpers.
 *
 * Extracted from localRuntimeAdapter.ts. These are pure functions that write
 * child-dialog status records through a HybridRecordStore — no module-level
 * state, no shared caches — so they can be unit-tested in isolation.
 *
 * Re-exported through localRuntimeAdapter.ts (barrel) for internal use.
 */
import type { HybridRecordStore } from "./hybridRecordStore";

/**
 * Persist a freshly created child dialog as `status: "pending"`.
 * Called by createCliCallAgentToolExecutor right after allocating the child
 * dialog id, before runChildTurn kicks off.
 */
export async function persistCliPendingChildDialog(args: {
  store: HybridRecordStore;
  userId: string;
  dialogId: string;
  agentKey: string;
  title: string;
  spaceId?: string;
  parentDialogId?: string;
  rootDialogId?: string;
  workspaceRoot: string;
  background: boolean;
  now: number;
}) {
  const nowIso = new Date(args.now).toISOString();
  const dialogKey = `dialog-${args.userId}-${args.dialogId}`;
  const record: Record<string, unknown> = {
    id: args.dialogId,
    dbKey: dialogKey,
    type: "dialog",
    userId: args.userId,
    cybots: [args.agentKey],
    primaryAgentKey: args.agentKey,
    title: args.title.slice(0, 80),
    status: "pending",
    triggerType: "cli-local",
    executionMode: args.background ? "background" : "foreground",
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(args.spaceId ? { spaceId: args.spaceId } : {}),
    ...(args.parentDialogId ? { parentDialogId: args.parentDialogId } : {}),
    ...(args.rootDialogId ? { rootDialogId: args.rootDialogId } : {}),
    localRuntime: {
      host: "cli",
      workspaceRoot: args.workspaceRoot,
      workspaceKind: "current",
      workspaceAccess: "inherited",
    },
  };
  await args.store.batch([{ type: "put", key: dialogKey, value: record }]);
}

/**
 * Mark an existing child dialog as `status: "failed"` with the error message.
 * Preserves all prior fields (cybots, parentDialogId, etc.) by merging onto
 * the existing record.
 */
export async function persistCliFailedChildDialog(args: {
  store: HybridRecordStore;
  userId: string;
  dialogId: string;
  errorMessage: string;
  now: number;
}) {
  const dialogKey = `dialog-${args.userId}-${args.dialogId}`;
  const existing = await args.store.read(dialogKey);
  const existingRecord =
    existing && typeof existing === "object"
      ? (existing as Record<string, unknown>)
      : {};
  await args.store.batch([
    {
      type: "put",
      key: dialogKey,
      value: {
        ...existingRecord,
        id: args.dialogId,
        dbKey: dialogKey,
        status: "failed",
        errorMessage: args.errorMessage,
        updatedAt: new Date(args.now).toISOString(),
        finishedAt: args.now,
      },
    },
  ]);
}