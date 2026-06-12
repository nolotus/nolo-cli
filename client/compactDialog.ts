// packages/cli/client/compactDialog.ts
// HTTP-only compact helper for CLI TUI (no Redux store available).

import { ulid } from "ulid";

const DB_PATH = "/api/v1/db";

/**
 * Extract userId from a JWT-style auth token without verifying the signature.
 * Mirrors the logic of `parseToken` in `auth/token.ts` without the crypto imports.
 * @internal - exported for testing only
 */
export function parseTokenUserId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadBase64 = parts[1];
    const payload = JSON.parse(
      Buffer.from(payloadBase64, "base64").toString("utf8")
    );
    return typeof payload?.userId === "string" ? payload.userId : null;
  } catch {
    return null;
  }
}

/**
 * Extract the custom ID (ULID) from a dialog key like `dialog-{userId}-{id}`.
 * Mirrors `extractCustomId` from `core/prefix` without importing it.
 */
function extractCustomId(key: string): string {
  const parts = key.split("-");
  return parts.slice(2).join("-");
}

async function readDialogRecord(
  fetchImpl: typeof fetch,
  serverUrl: string,
  authToken: string,
  dialogKey: string
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${serverUrl}${DB_PATH}/read/${dialogKey}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to read dialog "${dialogKey}": HTTP ${res.status}`);
  }
  const data = await res.json();
  return data as Record<string, unknown>;
}

/**
 * Fields carried forward from the source dialog into the fork.
 * Conversation summary/compression state is intentionally excluded so the new
 * dialog starts clean: summary, summarizedBeforeId, proactiveSummary,
 * proactiveSummaryBeforeId, compressionCount, summaryPending must NOT be
 * inherited — they describe the old conversation, not the fork.
 */
const FORKED_CARRY_FIELDS = [
  "cybots",
  "type",
  "title",
  "spaceId",
  "category",
  "referenceKeys",
  "triggerType",
  "schedule",
  "taskPrompt",
  "executionMode",
] as const;

function buildForkedDialogRecord(
  current: Record<string, unknown>,
  userId: string
): Record<string, unknown> & { dbKey: string; id: string } {
  const newId = ulid();
  const dbKey = `dialog-${userId}-${newId}`;
  const now = new Date().toISOString();

  // Explicitly pick only the allowed fields — never spread `current` wholesale.
  const carried: Record<string, unknown> = {};
  for (const field of FORKED_CARRY_FIELDS) {
    if (current[field] !== undefined) {
      carried[field] = current[field];
    }
  }

  return {
    ...carried,
    id: newId,
    dbKey,
    inheritedFromDialogKey: current.dbKey,
    inheritedFromDialogTitle: current.title,
    createdAt: now,
    updatedAt: now,
    // reset per-dialog stats
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
  };
}

async function writeDialogRecord(
  fetchImpl: typeof fetch,
  serverUrl: string,
  authToken: string,
  record: Record<string, unknown> & { dbKey: string }
): Promise<void> {
  const res = await fetchImpl(`${serverUrl}${DB_PATH}/write/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ data: record, customKey: record.dbKey }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to write forked dialog "${record.dbKey}": HTTP ${res.status}`
    );
  }
}

/**
 * Best-effort: register the forked dialog in the space sidebar.
 * Failure here is non-fatal since the dialog is already stored.
 */
async function addDialogToSpaceIfNeeded(
  fetchImpl: typeof fetch,
  serverUrl: string,
  authToken: string,
  record: Record<string, unknown> & { dbKey: string }
): Promise<void> {
  const rawSpaceId = record.spaceId;
  if (!rawSpaceId || typeof rawSpaceId !== "string") return;

  const normalizedSpaceId = rawSpaceId.startsWith("space-")
    ? rawSpaceId.slice("space-".length)
    : rawSpaceId;
  const spaceKey = `space-${normalizedSpaceId}`;
  const now = Date.now();

  const contentEntry = {
    title: typeof record.title === "string" ? record.title : record.id,
    type: "dialog",
    contentKey: record.dbKey,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await fetchImpl(`${serverUrl}${DB_PATH}/patch/${spaceKey}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ contents: { [record.dbKey]: contentEntry } }),
    });
    if (!res.ok) {
      console.warn(
        `[nolo] compact: addDialogToSpace failed for ${spaceKey}: HTTP ${res.status}`
      );
    }
  } catch (error) {
    console.warn(`[nolo] compact: addDialogToSpace error: ${error}`);
  }
}

export type CompactDialogResult = {
  dialogId: string;
  dialogKey: string;
  spaceId?: string;
};

/**
 * Compact the current dialog by forking it:
 * 1. Read the current dialog config from the server.
 * 2. Build a new dialog record that inherits from the old one.
 * 3. Write the new record to the server.
 * 4. Register the new dialog in the space sidebar (best-effort).
 *
 * Returns the new dialog's ID so the TUI can switch to it.
 */
export async function compactDialog(options: {
  serverUrl: string;
  authToken: string;
  dialogId: string;
  fetchImpl?: typeof fetch;
}): Promise<CompactDialogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const userId = parseTokenUserId(options.authToken);
  if (!userId) {
    throw new Error(
      "[nolo] compact: cannot compact — invalid or missing auth token"
    );
  }

  const dialogKey = `dialog-${userId}-${options.dialogId}`;
  const current = await readDialogRecord(
    fetchImpl,
    options.serverUrl,
    options.authToken,
    dialogKey
  );
  const next = buildForkedDialogRecord(current, userId);
  await writeDialogRecord(fetchImpl, options.serverUrl, options.authToken, next);
  await addDialogToSpaceIfNeeded(
    fetchImpl,
    options.serverUrl,
    options.authToken,
    next
  );

  return {
    dialogId: extractCustomId(next.dbKey),
    dialogKey: next.dbKey,
    spaceId: typeof next.spaceId === "string" ? next.spaceId : undefined,
  };
}
