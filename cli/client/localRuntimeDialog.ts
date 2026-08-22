import type {
  AgentRuntimeChatMessage,
  AgentRuntimeSaveTurnInput,
} from "../../agent-runtime";
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
} from "../../agent-runtime/platformChatProvider";
import { generateLocalDialogTitle } from "../../agent-runtime/dialogTitleLlm";
import {
  fetchWithTransientRetry,
  type FetchInput,
  type FetchInit,
} from "./localRuntimeFetchRetry";
import { prepareTokenUsageData } from "../../ai/token/prepareTokenUsageData";
import { applyTokenUsageToDayStats } from "../../ai/token/applyTokenUsageToDayStats";
import { createTokenKey, createTokenStatsKey } from "../../database/keys";
import { runKeyed } from "../../core/keyedTaskQueue";
import { format } from "date-fns";
import { type EnvLike } from "./localRuntimeHelpers";
import {
  extractLastUserText,
  localTurnHasSubjectRefs,
} from "./cliAgentConfigHelpers";
import { buildLocalDialogWritePlan } from "./localDialogRecords";
import { syncLocalDialogEvidenceToRemote } from "./cliRemoteDialogSync";
import { resolveCliOpenAiProviderConfig } from "./localProviderResolver";
import { buildDialogFallbackTitleFromUserInput } from "../../chat/dialog/dialogTitle";
import { toErrorMessage } from "../../core/errorMessage";
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
   * @deprecated title 生成现在是 fire-and-forget，此参数不再阻塞 turn
   * 返回。保留声明仅为向后兼容（测试注入用），实际值不再被使用。
   */
  titleTimeoutMs?: number;
}) {
  const __perfEnabled = args.env?.NOLO_CLI_PERF === "1";
  const __perfT0 = __perfEnabled ? performance.now() : 0;
  let existingDialog: any = null;
  if (args.input.continueDialogId) {
    const dialogKey = `dialog-${args.userId}-${args.input.continueDialogId}`;
    existingDialog = await args.store.read(dialogKey);
  }
  if (__perfEnabled) {
    const ms = (performance.now() - __perfT0).toFixed(1);
    process.stderr.write(`[nolo-perf] writeDialog A:read-dialog: ${ms}ms\n`);
  }

  const nowMs = args.now();
  const existingTitle =
    typeof existingDialog?.title === "string" ? existingDialog.title.trim() : "";
  const existingTitleSource = existingDialog?.titleSource;

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

  // PERF: title 生成改为 fire-and-forget。不再 await Promise.race 阻塞 turn
  // 返回——实测 title LLM 调用稳定撞穿 2500ms 超时（见 baseline），用户白白
  // 等 2.5 秒却什么都没拿到。现在先用 fallback title 写入并立即返回，title
  // 回来后后台 patch dialog 记录。one-shot CLI 进程退出时 title 可能丢失，
  // 但 TUI 是长驻进程，patch 几乎总能完成；即使丢失，下一轮 title 节流逻辑
  // 会重新生成（needsTitleUpdate 仍为 true，因为 titleUpdatedAt 未刷新）。
  let titlePromise: Promise<string | null> | undefined;
  if (needsTitleUpdate && args.titleGenerator) {
    const rawLastUserText = extractLastUserText(args.input.messages);
    const fallbackTitle =
      buildDialogFallbackTitleFromUserInput(rawLastUserText) || "Local agent run";
    titlePromise = args
      .titleGenerator({ messages: args.input.messages, fallbackTitle })
      .catch(() => null as string | null);
  }

  // 不再 await title——用 fallback title 走 plan，立即持久化并返回。
  const plan = buildLocalDialogWritePlan({
    input: args.input,
    userId: args.userId,
    now: nowMs,
    createId: args.createId,
    existingDialog,
    cwd: args.cwd,
  });
  await args.store.batch(plan.ops);
  if (__perfEnabled) {
    const ms = (performance.now() - __perfT0).toFixed(1);
    process.stderr.write(`[nolo-perf] writeDialog C:store-batch (cumulative): ${ms}ms\n`);
  }

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
  if (__perfEnabled) {
    const ms = (performance.now() - __perfT0).toFixed(1);
    process.stderr.write(`[nolo-perf] writeDialog D:token-record (cumulative): ${ms}ms\n`);
  }

  const hasSubjectRefs = localTurnHasSubjectRefs(args.input);
  const isLocalUser = args.userId === "local";
  // PERF: 暴露 remote sync promise 让测试可等待；调用方不 await（subjectRef 除外）。
  let remoteSyncPromise: Promise<void> | undefined;
  if (!isLocalUser) {
    if (hasSubjectRefs) {
      // subjectRef 场景保留 await + throw：task 关联的对话证据必须远端
      // 可查，失败时让 turn 失败比静默丢证据更安全。
      remoteSyncPromise = (async () => {
        const syncResult = await syncLocalDialogEvidenceToRemote({
          env: args.env,
          fetchImpl: args.fetchImpl,
          input: args.input,
          ops: [...plan.ops, ...tokenOps],
          output: args.output,
          userId: args.userId,
        });
        if (!syncResult.attempted) {
          args.output?.write(
            "[nolo] Local dialog evidence is local-only; set NOLO_SERVER and AUTH_TOKEN to make subjectRefs remotely queryable.\n",
          );
        }
      })();
      await remoteSyncPromise;
    } else {
      // PERF: 非 subjectRef 场景的 remote-sync 改为 fire-and-forget。实测
      // 每轮 1-1.9 秒网络 I/O，是后续轮次"最后一句话后等待"的主要原因。
      // sync 结果不进 writeDialog 返回值，只用于远端备份——不值得阻塞 turn。
      // 失败时只提示用户，不 throw。
      remoteSyncPromise = syncLocalDialogEvidenceToRemote({
        env: args.env,
        fetchImpl: args.fetchImpl,
        input: args.input,
        ops: [...plan.ops, ...tokenOps],
        output: args.output,
        userId: args.userId,
      }).catch((error) => {
        args.output?.write(
          `[nolo] Remote dialog evidence sync failed; local dialog only: ${toErrorMessage(error)}\n`,
        );
      });
    }
  }

  // PERF: title 后台 patch——titlePromise resolve 后读回 dialog 记录、
  // patch title + titleSource + titleUpdatedAt，再 write 回去。
  // 不阻塞 writeDialog 返回；失败静默（下一轮节流会重试）。
  // 返回 titlePatchPromise 让测试可等待 patch 完成；调用方（saveTurn）
  // 不 await 它——patch 完成与否不影响 turn 返回。
  // patch 成功时 resolve 携带最终标题（失败/被跳过为 null），供长驻宿主
  // （TUI）在 patch 完成后刷新窗口标题（OSC），不必等下一轮 turn。
  let titlePatchPromise: Promise<string | null> | undefined;
  if (titlePromise) {
    const dialogKey = `dialog-${args.userId}-${plan.dialogId}`;
    titlePatchPromise = titlePromise.then(async (resolvedTitle) => {
      if (!resolvedTitle) return null;
      try {
        const existing = await args.store.read(dialogKey);
        if (!existing || typeof existing !== "object") return null;
        // 尊重 manual title：用户手动设的标题不被 LLM 覆盖。
        if (existing?.titleSource === "manual") return null;
        // H-1 修复：竞态保护——如果 patch 读回的 record 的 titleUpdatedAt
        // 比本轮（nowMs）更新，说明已有更新的 turn 写过这条 dialog。跳过
        // patch 避免用旧 turn 的 titleUpdatedAt 覆盖新 turn 的值（会污染
        // 新 turn 的 title 30 分钟节流判断）。
        const existingTitleUpdatedAtMs = parseTitleUpdatedAtMs(existing);
        if (existingTitleUpdatedAtMs > nowMs) return null;
        await args.store.write(dialogKey, {
          ...existing,
          title: resolvedTitle,
          titleSource: "auto",
          titleUpdatedAt: new Date(nowMs).toISOString(),
        });
        return resolvedTitle;
      } catch {
        // 静默失败：下一轮 needsTitleUpdate 仍为 true（titleUpdatedAt 未刷新），
        // 会重新生成。不值得为此打扰用户。
        return null;
      }
    });
  }

  if (__perfEnabled) {
    const ms = (performance.now() - __perfT0).toFixed(1);
    process.stderr.write(`[nolo-perf] writeDialog total (blocking): ${ms}ms\n`);
  }
  return { dialogId: plan.dialogId, title: plan.title, titlePatchPromise, remoteSyncPromise };
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
