/**
 * CLI-side memory rekey: migrate local anonymous memories (owner={user,machineId})
 * to the cloud account (owner={user,accountUserId}) after a successful login.
 *
 * Flow: scan local owner range → upload items to POST /api/memory/rekey →
 * delete local items by snapshot ids (race-safe against background writes).
 *
 * Triggered from the login flow (see wireRekeyAfterLogin in authCommands.ts).
 * Failures are logged and never block login — rekey is an enhancement, not a
 * requirement.
 */
import { deleteMemoriesForOwnerFromDb } from "../ai/memory/delete";
import { createMemoryKey, memoryOwnerRange } from "../database/keys";
import type { MemoryItem } from "../ai/memory/types";

export interface PerformLocalMemoryRekeyArgs {
  /** Local LevelDB handle (CliLocalRuntimeDb or compatible). */
  localDb: any;
  /** Auth token (JWT) just obtained from login. */
  authToken: string;
  /** Server base URL, e.g. https://nolo.chat. */
  serverUrl: string;
  /** Machine id used as the anonymous ownerId before login. */
  machineId: string;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface RekeyResult {
  migrated: number;
  merged: number;
}

/**
 * Scan local memories for the anonymous owner range (user, machineId) and
 * return the full MemoryItem list + snapshot ids. Read-only — does not delete.
 */
async function scanLocalMemoryItems(
  localDb: any,
  machineId: string
): Promise<MemoryItem[]> {
  const range = memoryOwnerRange("user", machineId);
  const refs: Array<{ memoryId?: string }> = [];
  for await (const [, value] of localDb.iterator({
    gte: range.start,
    lte: range.end,
    reverse: true,
  })) {
    refs.push(value ?? {});
  }
  const items = await Promise.all(
    refs.map((ref) =>
      typeof ref?.memoryId === "string"
        ? localDb
            .get(createMemoryKey("user", machineId, ref.memoryId))
            .catch(() => null)
        : Promise.resolve(null)
    )
  );
  return items.filter((item): item is MemoryItem => !!item);
}

/**
 * Perform the local→cloud memory rekey.
 *
 * Steps:
 * 1. Scan local owner range (read-only).
 * 2. If empty, return {migrated:0, merged:0} immediately.
 * 3. POST items to /api/memory/rekey with Bearer auth.
 * 4. On 2xx: delete local items by snapshot ids (race-safe). Return counts.
 * 5. On non-2xx: throw — caller logs and keeps local data intact.
 */
export async function performLocalMemoryRekey(
  args: PerformLocalMemoryRekeyArgs
): Promise<RekeyResult> {
  const { localDb, authToken, serverUrl, machineId } = args;
  const fetchImpl = args.fetchImpl ?? fetch;

  const items = await scanLocalMemoryItems(localDb, machineId);
  if (items.length === 0) {
    return { migrated: 0, merged: 0 };
  }

  // Snapshot ids before upload — guards against background remember writes
  // that happen between scan and delete (new ulids won't be in this set).
  const snapshotIds = items.map((item) => item.id);

  // 30s timeout — rekey runs after login; a hang here would stall the login
  // command. On timeout the fetch rejects → caller try/catch logs + keeps local
  // data intact, login proceeds. AbortSignal.timeout is available in Bun/Node 18+.
  const response = await fetchImpl(`${serverUrl}/api/memory/rekey`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
    signal: AbortSignal?.timeout?.(30_000),
  } as any).catch((e: any) => {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error("memory rekey upload timed out (30s)");
    }
    throw e;
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message ?? "";
    } catch {
      // ignore parse failure
    }
    throw new Error(
      `memory rekey upload failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  const body = await response.json().catch(() => ({} as any));
  const migrated = typeof body?.migratedCount === "number" ? body.migratedCount : 0;
  const merged = typeof body?.mergedCount === "number" ? body.mergedCount : 0;

  // Delete local items by snapshot ids only — never delete items written
  // after the snapshot (new ulids from background remember).
  await deleteMemoriesForOwnerFromDb(
    localDb,
    { ownerType: "user", ownerId: machineId },
    { ids: snapshotIds }
  );

  return { migrated, merged };
}