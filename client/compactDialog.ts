// packages/cli/client/compactDialog.ts
// HTTP-only compact helper for CLI TUI (no Redux store available).
// Compares and forks: generate a summary of the old dialog, write it back,
// then create a new dialog that inherits the compressed context.

import { extractCustomId } from "../core/prefix";
import { ulid } from "ulid";
import type { CliFetchImpl } from "../cliFetch";
import type { Message } from "../chat/messages/types";
import { planCompression } from "../ai/context/planCompression";
import { getModelContextWindow, DEFAULT_CONTEXT_WINDOW } from "../ai/llm/getModelContextWindow";
import { serializeMessageContent } from "../chat/messages/messageContent";
import { extractReferenceKeysFromMessage } from "../chat/dialog/actions/extractReferenceKeys";
import {
  buildBuiltinSummaryContent,
  BUILTIN_SUMMARY_LLM_CONFIG,
} from "../chat/dialog/actions/builtinDialogLlm";

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

async function readDialogRecord(
  fetchImpl: CliFetchImpl,
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

async function readDialogMessages(
  fetchImpl: CliFetchImpl,
  serverUrl: string,
  authToken: string,
  dialogId: string
): Promise<Message[]> {
  const res = await fetchImpl(`${serverUrl}/api/dialog-read`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ dialogId, limit: 0 }),
  });
  if (!res.ok) {
    console.warn(`[nolo] compact: dialog-read failed: HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data?.msgs) ? data.msgs : [];
}

async function patchDialog(
  fetchImpl: CliFetchImpl,
  serverUrl: string,
  authToken: string,
  dialogKey: string,
  changes: Record<string, unknown>
): Promise<void> {
  const res = await fetchImpl(`${serverUrl}${DB_PATH}/patch/${dialogKey}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ data: changes }),
  });
  if (!res.ok) {
    throw new Error(`Failed to patch dialog "${dialogKey}": HTTP ${res.status}`);
  }
}

/**
 * Fields carried forward from the source dialog into the fork.
 * Includes compression state so the new dialog continues with the
 * compressed context (summary + summarizedBeforeId + referenceKeys).
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
  // Compression state — inherited so the forked dialog continues with
  // the compressed context rather than starting clean.
  "summary",
  "summarizedBeforeId",
  "compressionCount",
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
  fetchImpl: CliFetchImpl,
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
  fetchImpl: CliFetchImpl,
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
  /** Whether a summary was generated and written back to the old dialog. */
  summaryGenerated: boolean;
};

/**
 * Summary LLM caller — injected so tests can mock and production wires in the
 * platform chat proxy. Mirrors the dependency-injection pattern from
 * `generateLocalDialogTitle`.
 */
export type SummaryLlmCaller = (content: string) => Promise<string | null>;

function formatMessagesForSummary(msgs: Message[]): string {
  return msgs
    .map((m) => {
      const content = serializeMessageContent(m.content) || "[非文本内容]";
      return `${m.role}: ${content}`;
    })
    .join("\n");
}

/**
 * Resolve the agent's context window from the dialog's cybots[0] agent record.
 * Falls back to DEFAULT_CONTEXT_WINDOW if the agent or model is unknown.
 */
async function resolveContextWindow(
  fetchImpl: CliFetchImpl,
  serverUrl: string,
  authToken: string,
  agentKey: string | undefined
): Promise<number> {
  if (!agentKey) return DEFAULT_CONTEXT_WINDOW;
  try {
    const res = await fetchImpl(`${serverUrl}${DB_PATH}/read/${agentKey}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return DEFAULT_CONTEXT_WINDOW;
    const agent = await res.json();
    if (agent?.model) {
      return getModelContextWindow(agent.model) || DEFAULT_CONTEXT_WINDOW;
    }
  } catch {
    // Best-effort — fall back to default.
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compact the current dialog:
 * 1. Read the current dialog config and messages from the server.
 * 2. Use planCompression to decide whether/how much to compress.
 * 3. If compression is needed, call the summary LLM and write the summary
 *    back to the old dialog.
 * 4. Fork the dialog, inheriting the compressed context (summary + markers).
 * 5. Register the new dialog in the space sidebar (best-effort).
 *
 * This mirrors the Web `compactDialogAndForkAction` semantics: "compress then
 * fork with inherited summary" — not "fork clean".
 */
export async function compactDialog(options: {
  serverUrl: string;
  authToken: string;
  dialogId: string;
  fetchImpl?: CliFetchImpl;
  /** Injected LLM caller for summary generation. Production wires the platform chat proxy. */
  summaryLlmCaller?: SummaryLlmCaller;
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

  // --- Compression phase ---
  let summaryGenerated = false;

  if (options.summaryLlmCaller) {
    const allMsgs = await readDialogMessages(
      fetchImpl,
      options.serverUrl,
      options.authToken,
      options.dialogId
    );

    if (allMsgs.length > 0) {
      const agentKey =
        Array.isArray(current.cybots) && current.cybots.length > 0
          ? (current.cybots[0] as string)
          : undefined;
      const contextWindow = await resolveContextWindow(
        fetchImpl,
        options.serverUrl,
        options.authToken,
        agentKey
      );

      const plan = planCompression({
        allMsgs,
        summarizedBeforeId: current.summarizedBeforeId as string | undefined,
        summary: (current.summary as string) || "",
        contextWindow,
        force: true,
        reason: "manual",
      });

      if (plan.shouldCompress && plan.msgsToCompress.length > 0) {
        const previousSummary = (current.summary as string) || "";
        const messagesText = formatMessagesForSummary(plan.msgsToCompress);
        const promptContent = buildBuiltinSummaryContent(
          previousSummary,
          messagesText
        );

        try {
          const newSummary = await options.summaryLlmCaller(promptContent);

          if (newSummary && newSummary.trim()) {
            const compressionCount =
              (current.compressionCount as number) || 0;

            // Extract reference keys: start with existing keys, then collect
            // new keys from the messages being compressed into the summary.
            // This prevents page/dialog/table keys from being permanently lost
            // when their source messages are folded into the summary.
            const extractedKeys = new Set(
              Array.isArray(current.referenceKeys)
                ? (current.referenceKeys as string[])
                : []
            );
            for (const msg of plan.msgsToCompress) {
              for (const key of extractReferenceKeysFromMessage(msg)) {
                extractedKeys.add(key);
              }
            }

            await patchDialog(fetchImpl, options.serverUrl, options.authToken, dialogKey, {
              summary: newSummary.trim(),
              summarizedBeforeId: plan.newSummarizedBeforeId,
              compressionCount: compressionCount + 1,
              referenceKeys: Array.from(extractedKeys),
              summaryPending: false,
            });

            // Update `current` so the fork inherits the new summary + keys
            current.summary = newSummary.trim();
            current.summarizedBeforeId = plan.newSummarizedBeforeId;
            current.compressionCount = compressionCount + 1;
            current.referenceKeys = Array.from(extractedKeys);

            summaryGenerated = true;
            console.log(
              `[nolo] compact: compressed ${plan.compressCount} messages into summary (len: ${newSummary.trim().length})`
            );
          }
        } catch (error) {
          // Summary generation failed — continue with fork without compression.
          console.warn(`[nolo] compact: summary generation failed: ${error}`);
        }
      }
    }
  }

  // --- Fork phase ---
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
    summaryGenerated,
  };
}