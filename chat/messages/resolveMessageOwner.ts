import { asOptionalTrimmedString } from "../../core/optionalString";
import { parseOwnerUserIdFromDbKey } from "../../database/authority/ownerKey";

/**
 * Message / dialog-scoped record owner priority (local-first M3):
 *   1. explicit dialogConfig.userId (preferred authority passed in)
 *   2. parse the dialog key (covers `dialog-local-*` for device-local
 *      dialogs without forcing the caller to repeat the owner)
 *   3. currently logged-in account
 *   4. fall back to "local" so the write always has a real owner and
 *      never silently inherits undefined from Redux.
 *
 * Shared by user-message persistence, assistant stream-end writes, and
 * dialog token/stat stamping so all three hit the same device-local
 * replication boundary.
 */
export const resolveMessageOwner = (input: {
  dialogConfigUserId?: string | null;
  dialogKey: string;
  currentAccountUserId?: string | null;
}): string => {
  const dialogConfigUserId =
    asOptionalTrimmedString(input.dialogConfigUserId) ?? null;
  const currentAccountUserId =
    asOptionalTrimmedString(input.currentAccountUserId) ?? null;
  const resolvedKeyOwner = parseOwnerUserIdFromDbKey(input.dialogKey, {
    candidateOwnerUserIds: [dialogConfigUserId, currentAccountUserId, "local"],
  });
  return (
    dialogConfigUserId ?? resolvedKeyOwner ?? currentAccountUserId ?? "local"
  );
};
