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
import { createConcurrencyLimiter } from "../core/concurrencyLimiter";
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

// PERF: fire-and-forget 路径的并发限制常量。
// title patch 做 read-modify-write (2 次 broker IPC)，限 2 并发让前台 turn 优先。
const MAX_TITLE_PATCH_CONCURRENT = 2;
// remote sync 是 HTTP POST，限 3 并发避免大批量 turn 打爆远端 server。
// syncLocalDialogEvidenceToRemote 内部已有批内节流 (4 并发 + 300ms gap)，
// 这是跨 turn 的外层背压。
const MAX_REMOTE_SYNC_CONCURRENT = 3;
const titlePatchLimiter = createConcurrencyLimiter(MAX_TITLE_PATCH_CONCURRENT);
const remoteSyncLimiter = createConcurrencyLimiter(MAX_REMOTE_SYNC_CONCURRENT);

// PERF: 诊断打桩 helper——NOLO_CLI_PERF=1 时输出耗时到 stderr，生产零成本。
function createPerfTracker(env: EnvLike) {
  const enabled = env?.NOLO_CLI_PERF === "1";
  const t0 = enabled ? performance.now() : 0;
  return {
    enabled,
    mark(label: string, since?: number) {
      if (!enabled) return;
      const ms = (performance.now() - (since ?? t0)).toFixed(1);
      process.stderr.write(`[nolo-perf] writeDialog ${label}: ${ms}ms\n`);
    },
    t0,
  };
}

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

/**
 * PERF: title 后台 patch——titlePromise resolve 后读回 dialog 记录、
 * patch title + titleSource + titleUpdatedAt，再 write 回去。
 * 不阻塞 writeDialog 返回；失败静默（下一轮节流会重试）。
 * 通过 limiter 限流，防止大批量 turn 的 title patch 打爆 broker。
 *
 * 竞态保护（H-1）：如果 patch 读回的 record 的 titleUpdatedAt 比本轮
 * (nowMs) 更新，说明已有更新的 turn 写过这条 dialog。跳过 patch 避免
 * 用旧 turn 的 titleUpdatedAt 覆盖新 turn 的值。
 */
export function patchDialogTitleInBackground(args: {
  store: HybridRecordStore;
  dialogKey: string;
  titlePromise: Promise<string | null>;
  nowMs: number;
  limiter?: { run<T>(task: () => Promise<T>): Promise<T> };
}): Promise<void> {
  return args.titlePromise.then(async (resolvedTitle) => {
    if (!resolvedTitle) return;
    const limiter = args.limiter ?? titlePatchLimiter;
    await limiter.run(async () => {
      try {
        const existing = await args.store.read(args.dialogKey);
        if (!existing || typeof existing !== "object") return;
        if (existing?.titleSource === "manual") return;
        const existingTitleUpdatedAtMs = parseTitleUpdatedAtMs(existing);
        if (existingTitleUpdatedAtMs > args.nowMs) return;
        await args.store.write(args.dialogKey, {
          ...existing,
          title: resolvedTitle,
          titleSource: "auto",
          titleUpdatedAt: new Date(args.nowMs).toISOString(),
        });
      } catch {
        // 静默失败：下一轮 needsTitleUpdate 仍为 true，会重新生成。
      }
    });
  });
}

/**
 * PERF: remote-sync 封装——subjectRef 场景 await+throw（task 证据必须
 * 远端可查），非 subjectRef 场景 fire-and-forget（通过 limiter 限流，
 * 失败只提示不 throw）。消除 writeDialog 里两个分支的重复参数构造。
 */
export function syncDialogEvidence(args: {
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  input: AgentRuntimeSaveTurnInput;
  ops: Array<{ type: string; key: string; value: any }>;
  output?: { write(chunk: string): unknown };
  userId: string;
  hasSubjectRefs: boolean;
  limiter?: { run<T>(task: () => Promise<T>): Promise<T> };
}): Promise<void> {
  const syncArgs = {
    env: args.env,
    fetchImpl: args.fetchImpl,
    input: args.input,
    ops: args.ops,
    output: args.output,
    userId: args.userId,
  };
  if (args.hasSubjectRefs) {
    // subjectRef 场景：await + throw，证据必须远端可查。
    return (async () => {
      const syncResult = await syncLocalDialogEvidenceToRemote(syncArgs);
      if (!syncResult.attempted) {
        args.output?.write(
          "[nolo] Local dialog evidence is local-only; set NOLO_SERVER and AUTH_TOKEN to make subjectRefs remotely queryable.\n",
        );
      }
    })();
  }
  // 非 subjectRef 场景：fire-and-forget，限流 + 失败只提示。
  const limiter = args.limiter ?? remoteSyncLimiter;
  return limiter
    .run(() => syncLocalDialogEvidenceToRemote(syncArgs))
    .catch((error) => {
      args.output?.write(
        `[nolo] Remote dialog evidence sync failed; local dialog only: ${toErrorMessage(error)}\n`,
      );
    });
}

/**
 * MEDIUM-1: 判断是否需要重新生成 LLM 标题。
 * 节流规则（与 dialogWritePlan.ts 的 pickDialogTitle 共享 titleUpdatedAt 语义，
 * 但职责不同：这里决定"要不要花 LLM 调用生成"，pickDialogTitle 决定"用哪个 title"）：
 * - manual title 永不重生成
 * - 无 title → 需要生成
 * - titleUpdatedAt 超过 30 分钟 → 需要重生成
 * - titleUpdatedAt 缺失但有非空 title → 保守不重生成（旧记录兼容）
 */
function shouldRegenerateTitle(existingDialog: any, nowMs: number): boolean {
  const existingTitle =
    typeof existingDialog?.title === "string" ? existingDialog.title.trim() : "";
  const existingTitleSource = existingDialog?.titleSource;
  if (existingTitleSource === "manual") return false;
  if (!existingTitle) return true;
  const titleUpdatedAtMs = parseTitleUpdatedAtMs(existingDialog);
  if (titleUpdatedAtMs > 0) {
    return nowMs - titleUpdatedAtMs >= 30 * 60 * 1000;
  }
  return false;
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
}) {
  const perf = createPerfTracker(args.env);

  // A: 读已有 dialog（仅本地）——用于 title 节流判断 (titleUpdatedAt)。
  // PERF: remote: false——远端 fetch 对新对话必然 miss (dialog 刚由本轮
  // 创建)，实测白费 ~1.2s。
  let existingDialog: any = null;
  if (args.input.continueDialogId) {
    const dialogKey = `dialog-${args.userId}-${args.input.continueDialogId}`;
    existingDialog = await args.store.read(dialogKey, { remote: false });
  }
  perf.mark("A:read-dialog");

  const nowMs = args.now();
  const needsTitleUpdate = shouldRegenerateTitle(existingDialog, nowMs);

  // PERF: title 生成 fire-and-forget——先用 fallback title 写入返回，
  // title 回来后后台 patch (patchDialogTitleInBackground)。
  let titlePromise: Promise<string | null> | undefined;
  if (needsTitleUpdate && args.titleGenerator) {
    const rawLastUserText = extractLastUserText(args.input.messages);
    const fallbackTitle =
      buildDialogFallbackTitleFromUserInput(rawLastUserText) || "Local agent run";
    titlePromise = args
      .titleGenerator({ messages: args.input.messages, fallbackTitle })
      .catch(() => null as string | null);
  }

  // C: 写 dialog 记录 + 消息（用 fallback title，不阻塞等 LLM title）。
  const plan = buildLocalDialogWritePlan({
    input: args.input,
    userId: args.userId,
    now: nowMs,
    createId: args.createId,
    existingDialog,
    cwd: args.cwd,
  });
  await args.store.batch(plan.ops);
  perf.mark("C:store-batch (cumulative)");

  // D: 写 token 用量记录。
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
  perf.mark("D:token-record (cumulative)");

  // E: 远端同步——subjectRef 场景 await+throw，非 subjectRef fire-and-forget。
  const hasSubjectRefs = localTurnHasSubjectRefs(args.input);
  const isLocalUser = args.userId === "local";
  let remoteSyncPromise: Promise<void> | undefined;
  if (!isLocalUser) {
    remoteSyncPromise = syncDialogEvidence({
      env: args.env,
      fetchImpl: args.fetchImpl,
      input: args.input,
      ops: [...plan.ops, ...tokenOps],
      output: args.output,
      userId: args.userId,
      hasSubjectRefs,
    });
    if (hasSubjectRefs) await remoteSyncPromise;
  }

  // title 后台 patch——不阻塞 writeDialog 返回。
  let titlePatchPromise: Promise<void> | undefined;
  if (titlePromise) {
    const dialogKey = `dialog-${args.userId}-${plan.dialogId}`;
    titlePatchPromise = patchDialogTitleInBackground({
      store: args.store,
      dialogKey,
      titlePromise,
      nowMs,
    });
  }

  perf.mark("total (blocking)");
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
