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
import { createTokenKey } from "../database/keys";
import {
  resolveRuntimeAuthToken,
  type EnvLike,
} from "./localRuntimeHelpers";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import {
  extractLastUserText,
  localTurnHasSubjectRefs,
} from "./cliAgentConfigHelpers";
import { buildLocalDialogWritePlan } from "./localDialogRecords";
import { syncLocalDialogEvidenceToRemote } from "./cliRemoteDialogSync";
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
  return async (input) => {
    if (!canUsePlatformChatProvider(deps.env as any)) {
      return null;
    }
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
          },
        ),
      resolveProviderConfig: async (args: { agentConfig: any; env: any }) =>
        resolvePlatformChatProviderConfig({
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
      timeoutMs: 15_000,
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
}): Promise<void> {
  const rawUsage = args.input.result.usage;
  // Skip when usage is absent or empty — nothing meaningful to record.
  if (!rawUsage || typeof rawUsage !== "object" || Object.keys(rawUsage).length === 0) {
    return;
  }

  const timestamp = args.now();
  const prepared = prepareTokenUsageData({
    rawUsage,
    agentConfig: {
      model: args.input.result.model || "unknown",
      provider: args.input.result.provider,
      apiSource: "cli",
    },
    userId: args.userId,
    agentId: args.input.agentKey,
    dialogId: args.dialogId,
    timestamp,
    entry_path: "cli-local",
  });

  const recordKey = createTokenKey.record(args.userId, timestamp);
  const tokenRecord = {
    id: args.createId(),
    type: "token" as const,
    ...prepared.tokenData,
  };

  await args.store.write(recordKey, tokenRecord);
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
  let existingDialog: any = null;
  if (args.input.continueDialogId) {
    const dialogKey = `dialog-${args.userId}-${args.input.continueDialogId}`;
    existingDialog = await args.store.read(dialogKey);
  }

  const authToken = resolveRuntimeAuthToken(args.env);
  const isLoggedIn = Boolean(
    authToken &&
      (parseUserIdFromAuthToken(authToken) || args.env.NOLO_MACHINE_API_KEY?.trim()),
  );
  const hasExistingTitle =
    typeof existingDialog?.title === "string" && existingDialog.title.trim();

  let titleOverride: string | undefined;
  if (isLoggedIn && !hasExistingTitle && args.titleGenerator) {
    const fallbackTitle = extractLastUserText(args.input.messages).trim().slice(0, 80) || "Local agent run";
    try {
      const generated = await args.titleGenerator({
        messages: args.input.messages,
        fallbackTitle,
      });
      if (generated) {
        titleOverride = generated;
      }
    } catch {
      // Title generation failure must never block dialog persistence.
    }
  }

  const plan = buildLocalDialogWritePlan({
    input: args.input,
    userId: args.userId,
    now: args.now(),
    createId: args.createId,
    existingDialog,
    cwd: args.cwd,
    ...(titleOverride ? { titleOverride } : {}),
  });
  await args.store.batch(plan.ops);

  try {
    await writeLocalTokenRecord({
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
        ops: plan.ops,
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
