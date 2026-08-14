import type {
  AgentRuntimeChatMessage,
  AgentRuntimeSaveTurnInput,
} from "../agent-runtime";
import type { HybridRecordStore } from "./hybridRecordStore";
import { createCliHybridRecordStore } from "./hybridRecordStore";
import {
  defaultLocalRuntimeDb,
  normalizeRuntimeCacheCwd,
  hybridStoreCache,
  type CliLocalRuntimeAdapterDeps,
} from "./localRuntimeDiagnostics";
import {
  canUsePlatformChatProvider,
  hasDirectOpenAiCompatibleProvider,
  resolvePlatformChatProviderConfig,
  buildPlatformChatCompletionRequest,
  parsePlatformChatCompletionResponse,
} from "../agent-runtime/platformChatProvider";
import { generateLocalDialogTitle } from "../agent-runtime/dialogTitleLlm";
import {
  fetchWithTransientRetry,
  type FetchInput,
  type FetchInit,
} from "./localRuntimeFetchRetry";
import { prepareTokenUsageData } from "../ai/token/prepareTokenUsageData";
import { applyTokenUsageToDayStats } from "../ai/token/applyTokenUsageToDayStats";
import { createTokenKey, createTokenStatsKey } from "../database/keys";
import { runKeyed } from "../core/keyedTaskQueue";
import { format } from "date-fns";
import { type EnvLike } from "./localRuntimeHelpers";
import {
  extractLastUserText,
  localTurnHasSubjectRefs,
} from "./cliAgentConfigHelpers";
import { buildLocalDialogWritePlan } from "./localDialogRecords";
import { syncLocalDialogEvidenceToRemote } from "./cliRemoteDialogSync";
import { resolveCliOpenAiProviderConfig } from "./localProviderResolver";
import { buildDialogFallbackTitleFromUserInput } from "../chat/dialog/dialogTitle";
import { toErrorMessage } from "../core/errorMessage";
import type { CliFetchImpl } from "../cliFetch";

export async function resolveStore(deps: CliLocalRuntimeAdapterDeps) {
  if (deps.store) return deps.store;
  return createCliHybridRecordStore({
    db: deps.db ?? (await defaultLocalRuntimeDb()),
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
}

export async function getOrCreateSharedStore(deps: CliLocalRuntimeAdapterDeps) {
  if (deps.store) return deps.store;
  const cacheKey = normalizeRuntimeCacheCwd(deps.cwd);
  let storePromise = hybridStoreCache.get(cacheKey);
  if (!storePromise) {
    storePromise = resolveStore(deps);
    hybridStoreCache.set(cacheKey, storePromise);
  }
  return storePromise;
}

export function createLocalDialogTitleGenerator(
  deps: CliLocalRuntimeAdapterDeps,
  ctx: {
    apiKeyRefResolver: any;
    credentialBroker: any;
    loopbackRequest?: (input: FetchInput, init?: FetchInit) => Promise<Response>;
  },
): ((input: {
  messages: AgentRuntimeChatMessage[];
  fallbackTitle: string;
}) => Promise<string | null>) | null {
  // Only build a generator when at least one provider path is available:
  // the platform chat proxy (auth token) OR a direct OpenAI-compatible local
  // provider (OPENAI_API_KEY / base url / ollama). Without either, title
  // generation would always degrade to the fallback, so we skip it entirely
  // and let writeDialog use the synchronous fallback title.
  if (!canUsePlatformChatProvider(deps.env) && !hasDirectOpenAiCompatibleProvider(deps.env)) {
    return null;
  }
  return async (input) => {
    const result = await generateLocalDialogTitle({
      messages: input.messages,
      env: deps.env,
      fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTransientRetry(
          deps.fetchImpl ?? fetch,
          url as FetchInput,
          init as FetchInit | undefined,
          {
            sleep: deps.sleep,
            loopbackRequest: ctx.loopbackRequest,
            maxAttempts: 1,
          },
        ),
      resolveProviderConfig: async (args: { agentConfig: any; env: any }) =>
        resolvePlatformChatProviderConfig({
          agentConfig: args.agentConfig,
          env: args.env,
          apiKeyRefResolver: ctx.apiKeyRefResolver,
          credentialBroker: ctx.credentialBroker,
        }),
      resolveDirectProviderConfig: async (args: { agentConfig: any; env: any }) =>
        resolveCliOpenAiProviderConfig({
          agentConfig: args.agentConfig,
          env: args.env,
          apiKeyRefResolver: ctx.apiKeyRefResolver,
          credentialBroker: ctx.credentialBroker,
        }),
      buildRequest: (args: { providerConfig: any; messages: any; stream?: boolean }) =>
        buildPlatformChatCompletionRequest({
          providerConfig: args.providerConfig,
          messages: args.messages,
          stream: false,
        }),
      parseResponse: (args: { providerConfig: any; data: any }) =>
        parsePlatformChatCompletionResponse({
          providerConfig: args.providerConfig,
          data: args.data,
          trace: [],
        }),
      fallbackTitle: input.fallbackTitle,
      timeoutMs: 4_000,
    });
    return result.source === "llm" ? result.title : null;
  };
}

export async function writeLocalTokenRecord(args: {
  store: HybridRecordStore;
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  dialogId: string;
  now: () => number;
  createId: () => string;
  output?: { write(chunk: string): unknown };
}): Promise<Array<{ type: "put"; key: string; value: any }>> {
  const usageRecords = args.input.usageRecords?.length
    ? args.input.usageRecords
    : args.input.result.usage
      ? [{
          callId:
            typeof args.input.result.usage?.provider_call_id === "string" &&
            args.input.result.usage.provider_call_id.trim()
              ? args.input.result.usage.provider_call_id.trim()
              : args.createId(),
          usage: args.input.result.usage,
          model: args.input.result.model,
          ...(args.input.result.provider ? { provider: args.input.result.provider } : {}),
        }]
      : [];
  // Skip when usage is absent or empty — nothing meaningful to record.
  if (usageRecords.length === 0) {
    return [];
  }

  const ops: Array<{ type: "put"; key: string; value: any }> = [];
  for (const item of usageRecords) {
    if (!item.usage || Object.keys(item.usage).length === 0) continue;
    const timestamp = args.now();
    const callId =
      item.callId ||
      (typeof item.usage.provider_call_id === "string" && item.usage.provider_call_id.trim()) ||
      args.createId();
    const prepared = prepareTokenUsageData({
      rawUsage: item.usage,
      agentConfig: {
        model: item.model || args.input.billingConfig?.model || "unknown",
        provider: item.provider || args.input.billingConfig?.provider,
        apiSource: args.input.billingConfig?.apiSource,
        apiKeyRef: args.input.billingConfig?.apiKeyRef,
        inputPrice: args.input.billingConfig?.inputPrice,
        outputPrice: args.input.billingConfig?.outputPrice,
        sharingLevel: args.input.billingConfig?.sharingLevel,
        id: args.input.billingConfig?.id,
        userId: args.input.billingConfig?.userId,
      },
      userId: args.userId,
      agentId: args.input.agentKey,
      dialogId: args.dialogId,
      timestamp,
      entry_path: "cli-local",
    });

    const recordKey = createTokenKey.recordForStableCall(args.userId, callId);
    // Align with Desktop adapter: skip if detail token already recorded (idempotent retry).
    const existingToken = await args.store.read(recordKey, { remote: false }).catch(() => null);
    if (existingToken) continue;

    const tokenRecord = {
      id: args.createId(),
      type: "token" as const,
      ...prepared.tokenData,
    };

    await args.store.write(recordKey, tokenRecord);
    // Note: only detail records are returned in `ops` for remote sync.
    // Server-side `ownsCliProjection` handles server stats projection authoritatively from details,
    // avoiding dual-writer race conditions between stats upload and server projection.
    ops.push({ type: "put", key: recordKey, value: tokenRecord });

    // Update local DayStats under per-key queue so TUI displays stats immediately.
    const dateKey = format(timestamp, "yyyy-MM-dd");
    const statsKey = createTokenStatsKey(args.userId, dateKey);
    await runKeyed(statsKey, async () => {
      let existingStats: unknown = null;
      try {
        existingStats = await args.store.read(statsKey, { remote: false });
      } catch {
        // First stats entry for this day — start from null.
      }
      const newStats = applyTokenUsageToDayStats(existingStats, {
        userId: args.userId,
        timeKey: dateKey,
        model: prepared.billedModel,
        provider: prepared.recordProvider,
        input_tokens: prepared.usage.input_tokens,
        output_tokens: prepared.usage.output_tokens,
        cost: prepared.tokenData.cost,
      });
      const statsRecord = { ...newStats, id: statsKey, type: "token" as const };
      await args.store.write(statsKey, statsRecord);
    });
  }
  return ops;
}

export async function writeDialog(args: {
  store: HybridRecordStore;
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  now: () => number;
  createId: () => string;
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  output?: { write(chunk: string): unknown };
  cwd?: string;
  titleGenerator?: ((input: {
    messages: AgentRuntimeChatMessage[];
    fallbackTitle: string;
  }) => Promise<string | null>) | null;
  /**
   * HIGH-2(a): how long writeDialog waits for the LLM title before returning
   * with the fallback title. Defaults to 2500ms. Injectable for tests so the
   * timeout path can be exercised deterministically without real timers.
   */
  titleTimeoutMs?: number;
}) {
  let existingDialog: any = null;
  if (args.input.continueDialogId) {
    const dialogKey = `dialog-${args.userId}-${args.input.continueDialogId}`;
    existingDialog = await args.store.read(dialogKey);
  }

  const nowMs = args.now();
  const existingTitle =
    typeof existingDialog?.title === "string" ? existingDialog.title.trim() : "";
  const existingTitleSource = existingDialog?.titleSource;
  const titleTimeoutMs = args.titleTimeoutMs ?? 2500;

  // MEDIUM-1(a): throttle title regeneration by titleUpdatedAt (not updatedAt,
  // which is bumped every turn for unrelated fields). A manual title
  // (titleSource:"manual") is never regenerated. When titleUpdatedAt is
  // missing we are conservative: only regenerate when there is no existing
  // non-empty title — this avoids re-running the LLM on every turn for old
  // records that predate titleUpdatedAt.
  let needsTitleUpdate = false;
  if (existingTitleSource === "manual") {
    // MEDIUM-1(b): manual titles are never overwritten by LLM regeneration.
    needsTitleUpdate = false;
  } else if (!existingTitle) {
    needsTitleUpdate = true;
  } else {
    const titleUpdatedAtMs = parseTitleUpdatedAtMs(existingDialog);
    if (titleUpdatedAtMs > 0) {
      // 30-minute window (titleUpdated semantics: "idle 30 minutes").
      if (nowMs - titleUpdatedAtMs >= 30 * 60 * 1000) {
        needsTitleUpdate = true;
      }
    } else {
      // titleUpdatedAt missing → conservative: keep the existing non-empty
      // title, do NOT regenerate. (Old behavior treated missing as 0 → always
      // true → regenerated every turn, which was a regression.)
      needsTitleUpdate = false;
    }
  }

  let titlePromise: Promise<string | null> | undefined;
  if (needsTitleUpdate && args.titleGenerator) {
    const rawLastUserText = extractLastUserText(args.input.messages);
    const fallbackTitle =
      buildDialogFallbackTitleFromUserInput(rawLastUserText) || "Local agent run";
    titlePromise = args
      .titleGenerator({ messages: args.input.messages, fallbackTitle })
      .catch(() => null as string | null);
  }

  // HIGH-2(a): wait for the LLM title with a bounded timeout so a one-shot CLI
  // process does not exit before the title lands (the previous fire-and-forget
  // patch was lost on process exit). On timeout we keep the fallback title and
  // proceed — never hang. The race resolves to null on timeout / failure.
  let resolvedTitle: string | null = null;
  if (titlePromise) {
    let timeoutId: any;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), titleTimeoutMs);
    });
    try {
      resolvedTitle = await Promise.race([titlePromise, timeoutPromise]);
    } catch {
      resolvedTitle = null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // MEDIUM-2 (plan a): feed the LLM title through titleOverride so the contract
  // (titleOverride drives the persisted title) actually holds in production,
  // not just in tests. buildLocalDialogWritePlan → buildAgentRuntimeDialogWritePlan
  // applies titleOverride while respecting manual titles (MEDIUM-1). This also
  // means the persisted record AND the remote-sync ops carry the LLM title
  // (HIGH-2b), so no separate background patch is needed.
  const plan = buildLocalDialogWritePlan({
    input: args.input,
    userId: args.userId,
    now: nowMs,
    createId: args.createId,
    existingDialog,
    cwd: args.cwd,
    ...(resolvedTitle ? { titleOverride: resolvedTitle } : {}),
  });
  await args.store.batch(plan.ops);

  let tokenOps: Array<{ type: "put"; key: string; value: any }> = [];
  try {
    tokenOps = await writeLocalTokenRecord({
      store: args.store,
      input: args.input,
      userId: args.userId,
      dialogId: plan.dialogId,
      now: args.now,
      createId: args.createId,
      output: args.output,
    });
  } catch (error) {
    args.output?.write(
      `[nolo] Token usage record write failed (non-fatal): ${toErrorMessage(error)}\n`,
    );
  }

  const hasSubjectRefs = localTurnHasSubjectRefs(args.input);
  const isLocalUser = args.userId === "local";
  if (!isLocalUser) {
    try {
      const syncResult = await syncLocalDialogEvidenceToRemote({
        env: args.env,
        fetchImpl: args.fetchImpl,
        input: args.input,
        ops: [...plan.ops, ...tokenOps],
        output: args.output,
        userId: args.userId,
      });
      if (!syncResult.attempted) {
        if (hasSubjectRefs) {
          args.output?.write(
            "[nolo] Local dialog evidence is local-only; set NOLO_SERVER and AUTH_TOKEN to make subjectRefs remotely queryable.\n",
          );
        }
      }
    } catch (error) {
      if (hasSubjectRefs) {
        throw error;
      }
      args.output?.write(
        `[nolo] Remote dialog evidence sync failed; local dialog only: ${toErrorMessage(
          error,
        )}\n`,
      );
    }
  }
  return { dialogId: plan.dialogId, title: plan.title };
}

export function resolveCliDialogRecordKey(userId: string, dialogId: string): string {
  if (dialogId.startsWith("dialog-") && !dialogId.includes("-msg-")) {
    return dialogId;
  }
  return `dialog-${userId}-${dialogId}`;
}

export async function loadCliDialogSummary(args: {
  store: HybridRecordStore;
  userId: string;
  dialogId: string;
}): Promise<{ summary: string; summarizedBeforeId?: string } | null> {
  const dialogKey = resolveCliDialogRecordKey(args.userId, args.dialogId);
  const record = await args.store.read(dialogKey);
  if (!record || typeof record !== "object") return null;
  const summary =
    typeof (record as any).summary === "string"
      ? (record as any).summary.trim()
      : "";
  if (!summary) return null;
  const summarizedBeforeId = (record as any).summarizedBeforeId;
  return {
    summary,
    ...(typeof summarizedBeforeId === "string" && summarizedBeforeId
      ? { summarizedBeforeId }
      : {}),
  };
}

export async function saveCliDialogSummary(args: {
  store: HybridRecordStore;
  userId: string;
  dialogId: string;
  summary: string;
  summarizedBeforeId?: string;
}): Promise<void> {
  const dialogKey = resolveCliDialogRecordKey(args.userId, args.dialogId);
  const existing = (await args.store.read(dialogKey)) ?? {};
  const bareId =
    typeof (existing as any).id === "string" && (existing as any).id
      ? (existing as any).id
      : args.dialogId.startsWith("dialog-")
        ? args.dialogId.slice(args.dialogId.lastIndexOf("-") + 1)
        : args.dialogId;
  const compressionCount =
    typeof (existing as any).compressionCount === "number"
      ? (existing as any).compressionCount + 1
      : 1;
  await args.store.write(dialogKey, {
    ...existing,
    id: bareId,
    dbKey: dialogKey,
    type: "dialog",
    userId: args.userId,
    summary: args.summary,
    ...(args.summarizedBeforeId !== undefined
      ? { summarizedBeforeId: args.summarizedBeforeId }
      : {}),
    compressionCount,
    summaryPending: false,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * MEDIUM-1: parse titleUpdatedAt (ms epoch) from an existing dialog record for
 * the writeDialog throttle. Mirrors dialogWritePlan.parseTitleUpdatedAtMs.
 * Returns 0 when absent/unparseable — writeDialog treats 0 conservatively
 * (don't regenerate when a non-empty title already exists).
 */
function parseTitleUpdatedAtMs(existingDialog: any): number {
  const raw = existingDialog?.titleUpdatedAt;
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}
