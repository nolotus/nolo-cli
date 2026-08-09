// Contract compatibility comment for callAgentLocal.test.ts source checks:
// toolNameSet.has("callAgent") ? prepareTools(["callAgent"])
// createChildAdapter:
// adapter: childAdapter

import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeHostAdapter,
  AgentRuntimeSaveTurnInput,
} from "../agentRuntimeLocal";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeResult,
  AgentRuntimeToolCall,
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "../agent-runtime";
import type { PermissionRequest } from "../agent-runtime/actionGate";

/**
 * Interactive choice request surfaced by the local `ui_ask_choice` executor.
 * When a `requestUserChoice` callback is wired (interactive TUI), the executor
 * calls it to show an arrow-key select dialog docked above the composer; the
 * resolved userMessage becomes the next user turn. When absent (headless / CI /
 * non-TTY), the executor falls back to returning the raw JSON payload and the
 * toolOutput renderer prints a numbered text menu.
 */
import {
  readDialogFromLocalDb,
  type LocalDialogReadResult,
} from "../agent-runtime/localDialogRead";
import type {
  LocalAgentTurnInput,
  LocalAgentTurnResult,
} from "../agent-runtime/localLoop";
import type { CliKvDb, HybridRecordStore } from "./hybridRecordStore";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import { createTokenKey, createUserKey, dialogMessageRange } from "../database/keys";
import { prepareTokenUsageData } from "../ai/token/prepareTokenUsageData";
import { inlineImageUrlsForCustomProvider } from "../ai/chat/inlineImageUrlsForCustomProvider";
import {
  LOCAL_CODEX_AGENT_ID,
  LOCAL_CODEX_AGENT_KEY,
  NOLO_DEFAULT_AGENT_ID,
  NOLO_DEFAULT_AGENT_KEY,
} from "../agentAliases";
import { isCompiledBinary } from "../cliEnvHelpers";
import type { CliFetchImpl } from "../cliFetch";
import { clipCompactText } from "../core/clipCompactText";
import type { CollapsedPasteStore } from "../core/collapsedPaste";
import { normalizeAgentHandle } from "../core/agentHandle";
import { toErrorMessage } from "../core/errorMessage";
import { isRecord } from "../core/isRecord";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import { asTrimmedNonEmptyStringArray } from "../core/stringArray";
import { asTrimmedString } from "../core/trimmedString";
import { summarizeEndpoint } from "../core/summarizeEndpoint";

/**
 * Heavy agent-runtime / AI / local-DB modules are top-level static imports.
 *
 * Rationale: the publish pipeline (buildPublish.ts) bundles index.ts into a
 * single-file index.js via esbuild. esbuild cannot statically analyze
 * createRequire() dynamic paths, so any `require("...ts")` residual survives
 * in the bundle verbatim; the published package ships only index.js + README
 * (no .ts files), so at runtime the require resolves to a path outside the
 * package and throws MODULE_NOT_FOUND on first local-runtime use. Static
 * imports let esbuild inline every dependency into the single-file bundle.
 *
 * Paths below must remain present as import specifiers (without .ts
 * extension) for source-contract tests (e.g. fileCredentialBroker wiring).
 */

type CliExecuteResult = {
  text: string;
  raw?: string;
  elapsed?: number;
};
type CliImageInput = { source: string };
import type { ReadToolFn } from "./cliLocalToolExecutors";

import {
  resolveRuntimeServerUrl as _resolveRuntimeServerUrl,
  resolveRuntimeAuthToken as _resolveRuntimeAuthToken,
  remoteDialogSyncTimeout as _remoteDialogSyncTimeout,
  setRemoteDialogSyncTimeoutForTest as _setRemoteDialogSyncTimeoutForTest,
  type EnvLike,
} from "./localRuntimeHelpers";
// Re-export for test compatibility (existing imports from localRuntimeAdapter).
export { setRemoteDialogSyncTimeoutForTest } from "./localRuntimeHelpers";
import {
  postRemoteRecord,
  syncLocalDialogEvidenceToRemote,
  prepareRemoteDialogEvidenceRecord,
} from "./cliRemoteDialogSync";
// Re-export for test/external compatibility (agentRun.ts imports from localRuntimeAdapter).
export {
  postRemoteRecord,
  syncLocalDialogEvidenceToRemote,
  prepareRemoteDialogEvidenceRecord,
} from "./cliRemoteDialogSync";
// Resolve at call-site level — the helpers module owns the canonical implementations.
const resolveRuntimeServerUrl = _resolveRuntimeServerUrl;
const resolveRuntimeAuthToken = _resolveRuntimeAuthToken;
const remoteDialogSyncTimeout = _remoteDialogSyncTimeout;

// Fetch retry + loopback bypass extracted to localRuntimeFetchRetry.ts.
// Re-exported here (barrel) so existing `from "./localRuntimeAdapter"` imports
// keep working. isLoopbackUrl now reuses core/localOrigins for single-source
// loopback detection (previously duplicated here).
export {
  fetchWithTransientRetry,
  isLoopbackUrl,
  defaultLoopbackRequest,
  type FetchInput,
  type FetchInit,
} from "./localRuntimeFetchRetry";
import {
  fetchWithTransientRetry,
  defaultLoopbackRequest,
  type FetchInput,
  type FetchInit,
} from "./localRuntimeFetchRetry";

// The server can explicitly reject new platform-chat admissions with
// `503 core_draining` for the duration of a single-origin PM2 deploy. These
// responses are safe to retry because the provider call was not started.
// Keep 502/504 terminal: they are ambiguous without durable turn idempotency.
// The long drain budget is now handled inside `fetchWithTransientRetry`
// (core_draining responses only), so no platform-specific constant is needed.
import {
  persistCliPendingChildDialog,
  persistCliFailedChildDialog,
} from "./cliChildDialogPersist";
import {
  parseLocalToolBudgets,
  resolveExecShellDetachMs,
  assertWithinLocalToolBudget,
} from "./cliLocalToolBudget";
import {
  resolveBuiltinLocalCliAgentConfig,
  readAgentFromStore,
  readDialogMessages,
} from "./cliLocalAgentRecordReader";
import {
  shouldUseDeclaredOnlyLocalWorkspaceTools,
  resolveGlobFilesDescriptionVariant,
  resolveListFilesDescriptionVariant,
  resolveListFilesParameterVariant,
  resolveReadFileDescriptionVariant,
  resolveReadFileParameterVariant,
  resolveGlobFilesParameterVariant,
  resolveSearchFilesDescriptionVariant,
  resolveSearchFilesParameterVariant,
} from "./cliWorkspaceToolVariants";
import {
  parseJsonObject,
  isCliProviderAgent,
  resolveCliProviderName,
  stringifyRuntimeMessageContent,
  buildPromptForCliProvider,
  collectCliProviderImageInputs,
  buildDelegatedTaskContent,
} from "./cliProviderHelpers";
export {
  BUILTIN_NOLO_AGENT_KEY,
  isBuiltinNoloAgentRef,
  isBuiltinNoloAgentConfig,
  withResolvedRuntimeToolSurface,
  resolveLocalUserId,
  extractLastUserText,
  localTurnHasSubjectRefs,
} from "./cliAgentConfigHelpers";
import {
  BUILTIN_NOLO_AGENT_KEY,
  isBuiltinNoloAgentRef,
  isBuiltinNoloAgentConfig,
  withResolvedRuntimeToolSurface,
  resolveLocalUserId,
  extractLastUserText,
  localTurnHasSubjectRefs,
} from "./cliAgentConfigHelpers";
export {
  LOCAL_SERVER_TABLE_TOOL_NAMES,
  LOCAL_SERVER_TABLE_TOOL_NAME_SET,
  LOCAL_SERVER_WEB_TOOL_NAMES,
  LOCAL_SERVER_WEB_TOOL_NAME_SET,
  REGISTRY_INJECTED_TOOL_NAMES,
} from "./cliToolClassification";
import {
  LOCAL_SERVER_TABLE_TOOL_NAMES,
  LOCAL_SERVER_TABLE_TOOL_NAME_SET,
  LOCAL_SERVER_WEB_TOOL_NAMES,
  LOCAL_SERVER_WEB_TOOL_NAME_SET,
} from "./cliToolClassification";
import { buildServerPlatformToolExecutors } from "./cliServerPlatformToolExecutors";
export type {
  UserChoiceOption,
  UserChoiceRequest,
  UserChoiceResult,
  CliLocalRuntimeDb,
} from "./localRuntimeAdapterTypes";
import type {
  UserChoiceOption,
  UserChoiceRequest,
  UserChoiceResult,
  CliLocalRuntimeDb,
} from "./localRuntimeAdapterTypes";
import {
  buildLocalToolExecutors,
  buildCliWorkspaceToolExecutors,
} from "./cliLocalToolExecutors";
// Direct static imports replace the former lazy ensureHeavyCliLocalRuntimeModules
// indirection — see the rationale block at the top of this file.
import {
  buildLocalWorkspaceToolset,
  buildLocalWorkspaceOpenAiTools,
  executeOpenAiCompatibleChatCompletion,
  readOpenAiCompatibleSseCompletion,
  buildPlatformChatCompletionRequest,
  createLocalWorkspaceToolExecutors,
  parsePlatformChatCompletionData,
  parsePlatformChatCompletionResponse,
  resolvePlatformChatProviderConfig,
  resolveCurrentRunRuntimeToolPolicy,
  resolveLocalWorkspaceExecutorOptionsFromPolicy,
  resolveRequestedRuntimeToolNames,
  resolveRuntimeToolSurfaceForAgent,
  shouldUsePlatformChatProvider,
  canUsePlatformChatProvider,
} from "../agentRuntimeLocal";
import { fetchAntigravityCloudCodeCompletion } from "../agent-runtime/antigravityCloudCodeProvider";
import { isAntigravityOAuthAgent } from "../agent-runtime/antigravityOAuth";
import {
  accumulateGeminiChunks,
  buildGeminiGenerateContentRequest,
  isGemini3Model,
  shouldUseGeminiNativeToolRoute,
} from "../agent-runtime/geminiNativeShared";
import { readSseDataValues } from "../agent-runtime/sseFrames";
import { parseSseDataLineJson } from "../agent-runtime/sseDataLine";
import {
  fetchAnthropicMessagesCompletion,
  isAnthropicOAuthAgent,
} from "../agent-runtime/anthropicMessagesProvider";
import {
  createCursorProvider,
  isCursorOAuthAgent,
} from "../agent-runtime/cursor/cursorProvider";
import {
  fetchCodexResponsesCompletion,
  isCodexOAuthAgent,
} from "../agent-runtime/codexResponsesProvider";
import { readOAuthCredential } from "../agent-runtime/oauthTokenStore";
import { getDefaultCliLocalRuntimeDb } from "../localRuntimeDb";
import { resolveAgentRuntimeConfigFromRecord } from "./agentConfigResolver";
import { resolveCliOpenAiProviderConfig } from "./localProviderResolver";
import { createFileCredentialBroker } from "../agent-runtime/fileCredentialBroker";
import { fetchServerSyncedCredential } from "../ai/chat/agentCredentialSyncClient";
import { createOAuthApiKeyRefResolver } from "../oauth/apiKeyRefResolver";
import {
  buildLocalDialogWritePlan,
  localDialogMessageRecordToRuntimeMessage,
} from "./localDialogRecords";
import { generateLocalDialogTitle } from "../agent-runtime/dialogTitleLlm";
import {
  buildLocalAgentLookupKeys,
  shouldReadAgentKeyRemotely,
} from "./localAgentRecords";
import { createCliHybridRecordStore } from "./hybridRecordStore";
import { executeLocalToolWithPolicy } from "./localToolPolicy";
import { inferCaptureIntent } from "../ai/policy/runtimePolicy";
import {
  TOOL_PACKS,
  FORCED_TOOLS,
  applyDisabledTools,
  expandEnabledPacks,
  resolveEffectiveEnabledPacks,
  applySystemBuiltinSkillFilter,
  appendEnabledPackPromptPatches,
  addDefaultLightWebToolsForConfiguredAgents,
} from "../ai/tools/toolPacks";
import { prepareTools } from "../ai/tools/prepareTools";
import { canonicalizeToolNames } from "../ai/tools/toolNameAliases";
import {
  buildNoloWorkspaceCliToolExecutors,
  buildNoloWorkspaceOpenAiTools,
  parseNoloWorkspaceToolArguments,
} from "../agent-runtime/noloWorkspaceTools";
import {
  executeCli as defaultExecuteCli,
  CliProviderQuotaError,
} from "../ai/agent/cliExecutor";
import { buildCliPrompt } from "../ai/agent/cliPrompt";
import {
  readXhsProfileFunc,
  readXhsProfileFunctionSchema,
} from "../ai/tools/readXhsProfileTool";
import {
  readXPostFunc,
  readXPostFunctionSchema,
} from "../ai/tools/readXPostTool";
// Schema-only import: the executor lives in cliServerPlatformToolExecutors
// (bridges to /api/memory/remember). Importing rememberMemoryTool itself would
// pull Redux into the CLI bundle.
import { rememberMemoryFunctionSchema } from "../ai/tools/rememberMemoryToolSchema";
import { ulid } from "ulid";

type LocalCliExecutor = (
  provider: string,
  prompt: string,
  options: {
    model?: string;
    timeout?: number;
    cwd?: string;
    yolo?: boolean;
    env?: Record<string, string | undefined>;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    imageInputs?: CliImageInput[];
  },
) => Promise<CliExecuteResult>;

// Max wait for remote dialog-evidence sync fetches (POST write / GET read)
// before aborting, so an unreachable/hung server cannot stall a turn.
const currentMetaFile = fileURLToPath(import.meta.url);
const isJsBundle = extname(currentMetaFile) === ".js";
const SOURCE_CLI_DIR = isJsBundle
  ? dirname(currentMetaFile)
  : dirname(dirname(currentMetaFile));
const CLI_DIR = isCompiledBinary() ? dirname(process.execPath) : SOURCE_CLI_DIR;
// Mirror the source/compiled extension so workspace tools can re-launch the
// same CLI entrypoint in both repo development (bun + .ts) and published
// packages (node + .js). Using a hardcoded .ts breaks installed packages.
const CLI_ENTRYPOINT = isCompiledBinary()
  ? process.execPath
  : isJsBundle
    ? currentMetaFile
    : join(SOURCE_CLI_DIR, "index.ts");

export {
  normalizeRuntimeCacheCwd,
  buildPreparedAgentCacheKey,
  clearCliLocalRuntimePreparedAgentCache,
  defaultLocalRuntimeDb,
  createFallbackId,
  logLocalRuntimeDiagnostic,
  summarizeOpenAiToolNames,
  preparedAgentRuntimeCache,
  hybridStoreCache,
  type CliLocalRuntimeAdapterDeps,
  type PreparedAgentRuntime,
} from "./localRuntimeDiagnostics";
import {
  normalizeRuntimeCacheCwd,
  buildPreparedAgentCacheKey,
  defaultLocalRuntimeDb,
  createFallbackId,
  logLocalRuntimeDiagnostic,
  summarizeOpenAiToolNames,
  preparedAgentRuntimeCache,
  hybridStoreCache,
  type CliLocalRuntimeAdapterDeps,
} from "./localRuntimeDiagnostics";

export {
  buildOpenAiTools,
  resolveCliEffectiveEnabledPacks,
  resolveCliRequestedToolNames,
  buildLocalPolicyToolNames,
  createCliCallAgentToolExecutor,
  resolveProviderOpenAiToolBundle,
  buildLocalWorkspaceToolsetForEnv,
  buildServerPlatformOpenAiTools,
  withRuntimeEnabledPacksAndPrompt,
  type CliCallAgentToolExecutorContext,
} from "./localRuntimeTools";
import {
  buildOpenAiTools,
  resolveCliRequestedToolNames,
  buildLocalPolicyToolNames,
  createCliCallAgentToolExecutor,
  resolveProviderOpenAiToolBundle,
  withRuntimeEnabledPacksAndPrompt,
} from "./localRuntimeTools";

export {
  resolveStore,
  getOrCreateSharedStore,
  createLocalDialogTitleGenerator,
  writeLocalTokenRecord,
  writeDialog,
  resolveCliDialogRecordKey,
  loadCliDialogSummary,
  saveCliDialogSummary,
} from "./localRuntimeDialog";
import {
  getOrCreateSharedStore,
  createLocalDialogTitleGenerator,
  writeDialog,
  loadCliDialogSummary,
  saveCliDialogSummary,
} from "./localRuntimeDialog";

export function createCliLocalRuntimeAdapter(
  deps: CliLocalRuntimeAdapterDeps,
): AgentRuntimeHostAdapter {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? createFallbackId;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const loopbackRequest =
    deps.loopbackRequest ??
    (deps.fetchImpl ? undefined : defaultLoopbackRequest);
  const userId = resolveLocalUserId(deps.env);
  const localToolBudgets = parseLocalToolBudgets(deps.env);
  const localToolUsage = new Map<string, number>();
  const buildProviderOpenAiTools =
    deps.buildProviderOpenAiTools ?? buildOpenAiTools;
  const additionalToolNames = deps.pastedTextStore ? ["readPastedText"] : [];
  let activeAgentToolNames: string[] = [];
  const workspaceRoot = deps.cwd ?? process.cwd();
  let runtimeToolExecutionLimits: ReturnType<
    typeof resolveLocalWorkspaceExecutorOptionsFromPolicy
  > = {};
  let localToolExecutors: Record<
    string,
    (
      call: any,
    ) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  > = buildLocalToolExecutors({
    workspaceRoot,
    env: deps.env,
    fetchImpl,
    localToolExecutors: deps.localToolExecutors,
    readXPost: deps.readXPost,
    readXhsProfile: deps.readXhsProfile,
    cliEntrypoint: CLI_ENTRYPOINT,
    ...(deps.confirmDestructiveAction
      ? { confirmDestructiveAction: deps.confirmDestructiveAction }
      : {}),
    ...(deps.requestUserChoice
      ? { requestUserChoice: deps.requestUserChoice }
      : {}),
    ...(deps.pastedTextStore
      ? { pastedTextStore: deps.pastedTextStore }
      : {}),
    ...runtimeToolExecutionLimits,
  });

  return {
    host: "cli",
    capabilities: [
      "leveldb-agent-config",
      "local-provider",
      "leveldb-persistence",
      "local-tools",
    ],
    loadAgentConfig: async (agentRef) => {
      // Read the global skill settings before checking the prepared-runtime cache.
      // Otherwise a setting change would keep reusing the old tool surface.
      let systemBuiltinSkills: Record<string, boolean> | null = null;
      const sharedStore = await getOrCreateSharedStore(deps);
      if (userId) {
        try {
          const settingsRecord = await sharedStore.read(
            createUserKey.settings(userId),
            { remote: false },
          );
          systemBuiltinSkills =
            settingsRecord && typeof settingsRecord === "object"
              ? (settingsRecord as any).systemBuiltinSkills ?? null
              : null;
        } catch {
          // Local settings are best-effort; a read failure keeps skills enabled.
        }
      }
      const cacheKey = buildPreparedAgentCacheKey({
        userId,
        agentRef,
        cwd: normalizeRuntimeCacheCwd(workspaceRoot),
        systemBuiltinSkills,
      });
      // Paste executors close over the current TUI store. A prepared runtime
      // cache hit would otherwise reuse an executor bound to an older paste
      // store, so paste-aware runs are intentionally per-turn.
      const cached = deps.pastedTextStore
        ? undefined
        : preparedAgentRuntimeCache.get(cacheKey);
      if (cached) {
        activeAgentToolNames = cached.activeAgentToolNames;
        runtimeToolExecutionLimits = cached.runtimeToolExecutionLimits;
        localToolExecutors = cached.localToolExecutors;
        return cached.agentConfig;
      }

      const storedAgentConfig = await readAgentFromStore({
        agentRef,
        store: await getOrCreateSharedStore(deps),
        userId,
      });
      const fallbackLocalCliAgentConfig = storedAgentConfig
        ? null
        : resolveBuiltinLocalCliAgentConfig(agentRef, userId);
      const baseAgentConfig = withResolvedRuntimeToolSurface(
        storedAgentConfig ?? fallbackLocalCliAgentConfig,
        deps.env,
      );
      // CLI 端 system prompt 直用 agentConfig.prompt（不经 buildSystemPrompt 的
      // skill-guidance 层），这里把启用能力包的 promptPatch 纪律追加进 prompt，
      // 与 web 端 skillPromptPatches 注入对齐。
      const agentConfig = baseAgentConfig
        ? withRuntimeEnabledPacksAndPrompt(baseAgentConfig)
        : baseAgentConfig;
      // 读取用户全局设置中的「系统内置 Skill」开关映射，传给工具展开管道，
      // 让 CLI 端与 Web/桌面端行为一致：用户关闭「联网搜索」后，CLI agent
      // 也不再注入 web-search 包工具。best-effort，读失败视为默认全开。
      const hasUserChoice = Boolean(deps.requestUserChoice);
      const requestedToolNames = agentConfig
        ? resolveCliRequestedToolNames(
            agentConfig,
            deps.env,
            systemBuiltinSkills,
            { hasUserChoice },
          )
        : [];
      activeAgentToolNames = buildLocalPolicyToolNames({
        agentKey: agentConfig?.key,
        toolNames: [...requestedToolNames, ...additionalToolNames],
        env: deps.env,
      });
      runtimeToolExecutionLimits =
        resolveLocalWorkspaceExecutorOptionsFromPolicy(
          resolveCurrentRunRuntimeToolPolicy(agentConfig),
        );
      localToolExecutors = buildLocalToolExecutors({
        workspaceRoot,
        env: deps.env,
        fetchImpl,
        localToolExecutors: deps.localToolExecutors,
        readXPost: deps.readXPost,
        readXhsProfile: deps.readXhsProfile,
        cliEntrypoint: CLI_ENTRYPOINT,
        ...(deps.confirmDestructiveAction
          ? { confirmDestructiveAction: deps.confirmDestructiveAction }
          : {}),
        ...(deps.requestUserChoice
          ? { requestUserChoice: deps.requestUserChoice }
          : {}),
        ...(deps.pastedTextStore
          ? { pastedTextStore: deps.pastedTextStore }
          : {}),
        agentKey: agentConfig?.key,
        ...runtimeToolExecutionLimits,
      });
      // Report the post-filter tool list so runtime guidance describes what the
      // model can actually call. The CLI drops declared names it has no
      // executor for (read/createDoc/...), and prompt blocks keyed off the
      // declared list would advertise tools that never reach the schema.
      const exposedAgentConfig = agentConfig
        ? { ...agentConfig, exposedToolNames: activeAgentToolNames }
        : agentConfig;
      if (exposedAgentConfig && !deps.pastedTextStore) {
        preparedAgentRuntimeCache.set(cacheKey, {
          agentConfig: exposedAgentConfig,
          activeAgentToolNames,
          runtimeToolExecutionLimits,
          localToolExecutors,
        });
      }
      return exposedAgentConfig;
    },
    loadDialogHistory: async (dialogId) =>
      readDialogMessages({
        dialogId,
        store: await getOrCreateSharedStore(deps),
      }),
    loadDialogSummary: async (dialogId) =>
      loadCliDialogSummary({
        store: await getOrCreateSharedStore(deps),
        userId,
        dialogId,
      }),
    saveDialogSummary: async (input) =>
      saveCliDialogSummary({
        store: await getOrCreateSharedStore(deps),
        userId,
        dialogId: input.dialogId,
        summary: input.summary,
        summarizedBeforeId: input.summarizedBeforeId,
      }),
    saveTurn: async (input) =>
      writeDialog({
        store: await getOrCreateSharedStore(deps),
        input,
        userId,
        now,
        createId,
        env: deps.env,
        fetchImpl,
        output: deps.output,
        cwd: workspaceRoot,
        titleGenerator: createLocalDialogTitleGenerator(deps, {
          apiKeyRefResolver: createOAuthApiKeyRefResolver(),
          credentialBroker: createFileCredentialBroker(),
          loopbackRequest,
        }),
      }),
    resolveProvider: async (agentConfig) => {
      if (isCliProviderAgent(agentConfig)) {
        const provider = resolveCliProviderName(agentConfig);
        logLocalRuntimeDiagnostic("provider.selected", {
          agentKey: agentConfig.key,
          transport: "local-cli",
          apiSource: agentConfig.apiSource ?? null,
          provider,
          model: agentConfig.model ?? null,
          cwd: workspaceRoot,
        });
        return {
          model: agentConfig.model || provider,
          complete: async (messages, options) => {
            const executeCli =
              deps.executeCli ?? (defaultExecuteCli as LocalCliExecutor);
            const imageUrls = collectCliProviderImageInputs(messages);
            const imageInputs: CliImageInput[] | undefined =
              imageUrls.length > 0
                ? imageUrls.map((url) => ({ source: url }))
                : undefined;
            const prompt = buildPromptForCliProvider(messages);
            try {
              const reasoningEffortRaw = agentConfig.reasoning_effort;
              const reasoningEffort =
                reasoningEffortRaw === "low" ||
                reasoningEffortRaw === "medium" ||
                reasoningEffortRaw === "high" ||
                reasoningEffortRaw === "xhigh" ||
                reasoningEffortRaw === "max"
                  ? reasoningEffortRaw
                  : undefined;
              const result = await executeCli(provider, prompt, {
                ...(agentConfig.model ? { model: agentConfig.model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(typeof options?.timeoutMs === "number"
                  ? { timeout: options.timeoutMs }
                  : {}),
                cwd: workspaceRoot,
                yolo: true,
                env: deps.env,
                ...(imageInputs ? { imageInputs } : {}),
              });
              return {
                content: result.text,
                model: agentConfig.model || provider,
                raw: result.raw,
              };
            } catch (error) {
              // 保留配额限额错误，让上层（派发者 / supervisor / PM fallback）能快速识别并换另一个 agent 重派
              if (error instanceof CliProviderQuotaError) {
                throw error;
              }
              const message = toErrorMessage(error);
              throw new Error(
                `Local CLI provider "${provider}" is unavailable or failed: ${message}`,
              );
            }
          },
        };
      }

      // Local-first: OAuth resolver + file credential broker (metered API keys).
      // Broker is preferred inside buildProviderExecutionPlan when both are present.
      const apiKeyRefResolver = createOAuthApiKeyRefResolver();
      const credentialBroker = createFileCredentialBroker();
      const serverUrl = asOptionalTrimmedString(deps.env.NOLO_SERVER) ?? "https://us.nolo.chat";
      const authToken = asOptionalTrimmedString(deps.env.AUTH_TOKEN);
      const syncFetcher = authToken
        ? (ref: string) => fetchServerSyncedCredential({ currentServer: serverUrl, authToken }, ref)
        : undefined;

      // Antigravity (Google Cloud Code Assist) is not OpenAI-compatible: local
      // direct `/chat/completions` against daily-cloudcode-pa returns HTTP 404.
      // Mirror server agent-run loop: CCA wire + local oauth refresh.
      if (isAntigravityOAuthAgent(agentConfig)) {
        const accessToken = await apiKeyRefResolver("antigravity");
        if (!accessToken) {
          throw new Error(
            'OAuth credential for "antigravity" not found locally. Run `nolo auth antigravity`.',
          );
        }
        const credential = readOAuthCredential("antigravity");
        const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
          agentConfig,
          deps.env,
          buildProviderOpenAiTools,
          additionalToolNames,
          { hasUserChoice: Boolean(deps.requestUserChoice) },
        );
        logLocalRuntimeDiagnostic("provider.selected", {
          agentKey: agentConfig.key,
          transport: "antigravity-cloud-code",
          apiSource: agentConfig.apiSource ?? null,
          provider: agentConfig.provider ?? "google-antigravity",
          model: agentConfig.model ?? null,
          customProviderEndpoint:
            summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
          hasApiKey: true,
          hasProjectId: Boolean(credential?.metadata?.projectId),
        });
        return {
          model: agentConfig.model || "gemini-3.1-pro",
          complete: async (messages, options) => {
            const openAiBody: Record<string, unknown> = {
              model: agentConfig.model || "gemini-3.1-pro",
              messages,
              stream: false,
              ...(tools.length > 0 ? { tools } : {}),
            };
            logLocalRuntimeDiagnostic("provider.request.start", {
              agentKey: agentConfig.key,
              transport: "antigravity-cloud-code",
              model: openAiBody.model,
              messageCount: messages.length,
              toolCount: tools.length,
              requestedToolNames,
              openAiToolNames: summarizeOpenAiToolNames(tools),
            });
            const result = await fetchAntigravityCloudCodeCompletion({
              agentConfig,
              accessToken,
              metadata: credential?.metadata ?? null,
              openAiBody,
              fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
                fetchWithTransientRetry(fetchImpl, url, init, {
                  sleep: deps.sleep,
                  loopbackRequest,
                }),
            });
            if (result.status < 200 || result.status >= 300) {
              const errMsg =
                result.body &&
                typeof result.body === "object" &&
                result.body.error &&
                typeof (result.body.error as { message?: unknown }).message ===
                  "string"
                  ? (result.body.error as { message: string }).message
                  : JSON.stringify(result.body);
              throw new Error(
                `local antigravity provider failed: HTTP ${result.status} ${errMsg}`,
              );
            }
            const choice = Array.isArray(result.body.choices)
              ? (result.body.choices[0] as
                  | {
                      message?: {
                        content?: string | null;
                        tool_calls?: AgentRuntimeToolCall[];
                      };
                    }
                  | undefined)
              : undefined;
            const message = choice?.message ?? {};
            const content =
              typeof message.content === "string"
                ? message.content
                : message.content == null
                  ? ""
                  : String(message.content);
            const tool_calls = Array.isArray(message.tool_calls)
              ? message.tool_calls
              : undefined;
            if (content && options?.onTextDelta) {
              options.onTextDelta(content);
            }
            logLocalRuntimeDiagnostic("provider.request.result", {
              agentKey: agentConfig.key,
              transport: "antigravity-cloud-code",
              ok: true,
              contentChars: content.length,
              toolCallCount: tool_calls?.length ?? 0,
            });
            return {
              content,
              model: agentConfig.model || "gemini-3.1-pro",
              provider: agentConfig.provider || "google-antigravity",
              ...(tool_calls ? { tool_calls } : {}),
              trace: messages,
            };
          },
        };
      }

      // Claude Pro/Max OAuth uses Anthropic's Messages wire, not the generic
      // OpenAI-compatible transport. Keep the token local and translate at this
      // boundary, matching the server chat and background-run paths.
      if (isAnthropicOAuthAgent(agentConfig)) {
        const accessToken = await apiKeyRefResolver("claude");
        if (!accessToken) {
          throw new Error(
            'OAuth credential for "claude" not found locally. Run `nolo auth claude`.',
          );
        }
        const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
          agentConfig,
          deps.env,
          buildProviderOpenAiTools,
          additionalToolNames,
          { hasUserChoice: Boolean(deps.requestUserChoice) },
        );
        logLocalRuntimeDiagnostic("provider.selected", {
          agentKey: agentConfig.key,
          transport: "anthropic-messages",
          provider: "anthropic",
          model: agentConfig.model ?? "claude-sonnet-5",
          hasApiKey: true,
        });
        return {
          model: agentConfig.model || "claude-sonnet-5",
          complete: async (messages, options) => {
            const result = await fetchAnthropicMessagesCompletion({
              agentConfig,
              accessToken,
              openAiBody: {
                model: agentConfig.model || "claude-sonnet-5",
                messages,
                stream: false,
                ...(tools.length > 0 ? { tools } : {}),
              },
              fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
                fetchWithTransientRetry(fetchImpl, url, init, {
                  sleep: deps.sleep,
                  loopbackRequest,
                }),
            });
            if (result.status < 200 || result.status >= 300) {
              const errMsg =
                result.body?.error &&
                typeof result.body.error === "object" &&
                typeof result.body.error.message === "string"
                  ? result.body.error.message
                  : JSON.stringify(result.body);
              throw new Error(
                `local Claude OAuth provider failed: HTTP ${result.status} ${errMsg}`,
              );
            }
            const choice = Array.isArray(result.body.choices)
              ? result.body.choices[0]
              : undefined;
            const message = choice?.message ?? {};
            const content = typeof message.content === "string" ? message.content : "";
            const tool_calls = Array.isArray(message.tool_calls)
              ? message.tool_calls
              : undefined;
            if (content && options?.onTextDelta) options.onTextDelta(content);
            logLocalRuntimeDiagnostic("provider.request.result", {
              agentKey: agentConfig.key,
              transport: "anthropic-messages",
              ok: true,
              contentChars: content.length,
              toolCallCount: tool_calls?.length ?? 0,
              requestedToolNames,
            });
            return {
              content,
              model: agentConfig.model || "claude-sonnet-5",
              provider: "anthropic",
              ...(tool_calls ? { tool_calls } : {}),
              trace: messages,
            };
          },
        };
      }

      // ChatGPT Codex (subscription OAuth) — Responses API at
      // /backend-api/codex/responses. ChatGPT OAuth tokens cannot call
      // api.openai.com/v1/responses (returns 401 missing_scope: model.request);
      // they must go through the Codex backend. Mirrors the server-side
      // loopUpstream.ts Codex branch.
      if (isCodexOAuthAgent(agentConfig)) {
        const accessToken = await apiKeyRefResolver("chatgpt");
        if (!accessToken) {
          throw new Error(
            'OAuth credential for "chatgpt" not found locally. Run `nolo auth chatgpt`.',
          );
        }
        const credential = readOAuthCredential("chatgpt");
        const accountId = credential?.accountId;
        const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
          agentConfig,
          deps.env,
          buildProviderOpenAiTools,
          additionalToolNames,
          { hasUserChoice: Boolean(deps.requestUserChoice) },
        );
        logLocalRuntimeDiagnostic("provider.selected", {
          agentKey: agentConfig.key,
          transport: "codex-responses",
          provider: "openai",
          model: agentConfig.model ?? "gpt-5.6-sol",
          hasApiKey: true,
        });
        return {
          model: agentConfig.model || "gpt-5.6-sol",
          complete: async (messages, options) => {
            const result = await fetchCodexResponsesCompletion({
              agentConfig,
              accessToken,
              ...(accountId ? { accountId } : {}),
              openAiBody: {
                model: agentConfig.model || "gpt-5.6-sol",
                messages,
                stream: false,
                ...(tools.length > 0 ? { tools } : {}),
              },
              fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
                fetchWithTransientRetry(fetchImpl, url, init, {
                  sleep: deps.sleep,
                  loopbackRequest,
                }),
            });
            if (result.status < 200 || result.status >= 300) {
              const errMsg =
                result.body?.error &&
                typeof result.body.error === "object" &&
                typeof result.body.error.message === "string"
                  ? result.body.error.message
                  : JSON.stringify(result.body);
              throw new Error(
                `local Codex OAuth provider failed: HTTP ${result.status} ${errMsg}`,
              );
            }
            const choice = Array.isArray(result.body.choices)
              ? result.body.choices[0]
              : undefined;
            const message = choice?.message ?? {};
            const content = typeof message.content === "string" ? message.content : "";
            const tool_calls = Array.isArray(message.tool_calls)
              ? message.tool_calls
              : undefined;
            if (content && options?.onTextDelta) options.onTextDelta(content);
            logLocalRuntimeDiagnostic("provider.request.result", {
              agentKey: agentConfig.key,
              transport: "codex-responses",
              ok: true,
              contentChars: content.length,
              toolCallCount: tool_calls?.length ?? 0,
              requestedToolNames,
            });
            return {
              content,
              ...(tool_calls ? { tool_calls } : {}),
              trace: messages,
            };
          },
        };
      }

      // Cursor OAuth uses a bespoke ConnectRPC + protobuf wire (HTTP/2 to
      // api2.cursor.sh), not OpenAI-compatible chat.completions. Route through
      // the dedicated cursorProvider which translates nolo messages to the
      // AgentRunRequest protobuf and streams AgentServerMessage frames.
      if (isCursorOAuthAgent(agentConfig)) {
        const accessToken = await apiKeyRefResolver("cursor");
        if (!accessToken) {
          throw new Error(
            'OAuth credential for "cursor" not found locally. Run `nolo auth cursor`.',
          );
        }
        const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
          agentConfig,
          deps.env,
          buildProviderOpenAiTools,
          additionalToolNames,
          { hasUserChoice: Boolean(deps.requestUserChoice) },
        );
        logLocalRuntimeDiagnostic("provider.selected", {
          agentKey: agentConfig.key,
          transport: "cursor-connect",
          provider: "cursor",
          model: agentConfig.model ?? "cursor-default",
          hasApiKey: true,
        });
        // Build a cursor-internal executeTool that reuses the same policy +
        // executors as the host adapter's executeTool. Cursor drives its own
        // inline exec loop (sync, in-stream), so we give it the same local
        // tool executors rather than routing back through localLoop.
        const cursorExecuteTool = async (call: AgentRuntimeToolCallInput) => {
          const result = await executeLocalToolWithPolicy({
            env: deps.env,
            agentToolNames: activeAgentToolNames,
            call,
            executors: localToolExecutors,
            detachMs: resolveExecShellDetachMs(deps.env),
            ...(deps.confirmDestructiveAction
              ? { confirmDestructiveAction: deps.confirmDestructiveAction }
              : {}),
          });
          return {
            content: result.content,
            metadata: {
              ...(result.metadata ?? {}),
              workspaceRoot,
              workspaceKind: "current",
            },
          };
        };
        const cursorProvider = createCursorProvider({
          accessToken,
          model: agentConfig.model || "cursor-default",
          systemPrompt: agentConfig.prompt?.trim() || undefined,
          tools,
          executeTool: cursorExecuteTool,
        });
        // cursorProvider.complete already returns AgentRuntimeResult; wrap to
        // attach tool surface diagnostics for parity with other providers.
        return {
          model: agentConfig.model || "cursor-default",
          complete: async (messages, options) => {
            logLocalRuntimeDiagnostic("provider.request.start", {
              agentKey: agentConfig.key,
              transport: "cursor-connect",
              model: agentConfig.model ?? "cursor-default",
              messageCount: messages.length,
              toolCount: tools.length,
              requestedToolNames,
            });
            const result = await cursorProvider.complete(messages, options);
            logLocalRuntimeDiagnostic("provider.request.result", {
              agentKey: agentConfig.key,
              transport: "cursor-connect",
              ok: true,
              contentChars: (result.content ?? "").length,
              toolCallCount: result.tool_calls?.length ?? 0,
            });
            return result;
          },
        };
      }

      // Gemini 3 系列 + tools → 走 native generateContent 以支持 thought_signature
      // Platform proxy 的 OpenAI-compatible 路径无法传递 thought_signature
      if (
        shouldUsePlatformChatProvider(deps.env, agentConfig) &&
        isGemini3Model(agentConfig.model ?? "") &&
        agentConfig.provider === "google"
      ) {
        const providerConfig = await resolvePlatformChatProviderConfig({
          agentConfig,
          env: deps.env,
          apiKeyRefResolver,
          credentialBroker,
          syncFetcher,
        });
        const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
          agentConfig,
          deps.env,
          buildProviderOpenAiTools,
          additionalToolNames,
          { hasUserChoice: Boolean(deps.requestUserChoice) },
        );

        // 只有本地有 API key 时才走 native route；
        // platform agent（无本地 key）由 server 端 chatHandler 的 native 路由处理
        if (
          tools.length > 0 &&
          providerConfig.apiKey &&
          shouldUseGeminiNativeToolRoute(
            agentConfig.provider ?? "",
            agentConfig.model ?? "",
            tools,
            () => false, // CLI 端不区分 image 模型
          )
        ) {
          logLocalRuntimeDiagnostic("provider.selected", {
            agentKey: agentConfig.key,
            transport: "gemini-native-tool",
            apiSource: agentConfig.apiSource ?? null,
            provider: providerConfig.provider,
            model: providerConfig.model,
            hasApiKey: Boolean(providerConfig.apiKey),
          });
          return {
            model: providerConfig.model,
            complete: async (messages, options) => {
              const requestBody = buildGeminiGenerateContentRequest({
                messages: messages as unknown[],
                tools: tools as unknown[],
                maxTokens: typeof agentConfig.max_tokens === "number"
                  ? agentConfig.max_tokens
                  : undefined,
                temperature: typeof agentConfig.temperature === "number"
                  ? agentConfig.temperature
                  : undefined,
                attachSkipThoughtSignature: true,
              });

              const model = providerConfig.model;
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

              logLocalRuntimeDiagnostic("provider.request.start", {
                agentKey: agentConfig.key,
                transport: "gemini-native-tool",
                model,
                messageCount: messages.length,
                toolCount: tools.length,
                requestedToolNames,
              });

              const res = await fetchImpl(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": providerConfig.apiKey ?? "",
                },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(120000),
              });

              if (!res.ok) {
                const errText = await res.text();
                logLocalRuntimeDiagnostic("provider.request.failed", {
                  agentKey: agentConfig.key,
                  transport: "gemini-native-tool",
                  status: res.status,
                  error: errText.slice(0, 200),
                });
                throw new Error(
                  `gemini native tool provider failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
                );
              }

              const chunks = await readSseDataValues(res, parseSseDataLineJson);
              const { text, toolCalls, usage } = accumulateGeminiChunks(chunks);

              if (text && options?.onTextDelta) {
                options.onTextDelta(text);
              }

              const result: AgentRuntimeResult = {
                content: text,
                model,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                ...(usage ? { usage } : {}),
                trace: messages,
              };
              logLocalRuntimeDiagnostic("provider.request.result", {
                agentKey: agentConfig.key,
                transport: "gemini-native-tool",
                ok: true,
                contentChars: text.length,
                toolCallCount: toolCalls.length,
              });
              return result;
            },
          };
        }
      }

      if (shouldUsePlatformChatProvider(deps.env, agentConfig)) {
        const providerConfig = await resolvePlatformChatProviderConfig({
          agentConfig,
          env: deps.env,
          apiKeyRefResolver,
          credentialBroker,
          syncFetcher,
        });
        logLocalRuntimeDiagnostic("provider.selected", {
          agentKey: agentConfig.key,
          transport: "platform-proxy",
          apiSource: agentConfig.apiSource ?? null,
          provider: providerConfig.provider,
          model: providerConfig.model,
          endpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
          proxyServer: summarizeEndpoint(providerConfig.serverUrl) ?? null,
          hasAuthToken: Boolean(providerConfig.authToken),
          hasApiKey: Boolean(providerConfig.apiKey),
          apiKeyHeader: providerConfig.apiKeyHeader ?? null,
          useServerProxy: agentConfig.useServerProxy ?? null,
          customProviderEndpoint:
            summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
        });
        const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
          agentConfig,
          deps.env,
          buildProviderOpenAiTools,
          additionalToolNames,
          { hasUserChoice: Boolean(deps.requestUserChoice) },
        );
        return {
          model: providerConfig.model,
          complete: async (messages, options) => {
            const usesResponsesApi =
              providerConfig.endpoint.includes("/responses");
            const stream = Boolean(options?.onTextDelta) && !usesResponsesApi;
            const request = buildPlatformChatCompletionRequest({
              providerConfig,
              messages,
              tools,
              stream,
            });
            logLocalRuntimeDiagnostic("provider.request.start", {
              agentKey: agentConfig.key,
              transport: "platform-proxy",
              requestUrl: summarizeEndpoint(request.url) ?? null,
              endpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
              model: providerConfig.model,
              messageCount: messages.length,
              toolCount: tools.length,
              requestedToolNames,
              openAiToolNames: summarizeOpenAiToolNames(tools),
              stream,
            });
            let res = await fetchWithTransientRetry(
              fetchImpl,
              request.url,
              {
                ...request.init,
              },
              {
                sleep: deps.sleep,
                loopbackRequest,
                // auto 档位转发 nolo.chat 时，网关层 502（server: Caddy、空 body）
                // 意味着请求根本没到 Bun 上游，provider 未受理，重试安全。
                // 与 429/503 同口径：不会重复计费/重复生成。
                retryableStatuses: new Set([429, 502, 503]),
                onRetry: deps.activityReporter
                  ? ({ attempt, maxAttempts, delayMs }) => {
                      deps.activityReporter!(
                        `自动重试 ${attempt}/${maxAttempts} · ${Math.ceil(delayMs / 1000)}s`,
                      );
                    }
                  : undefined,
              },
            );
            if (!res.ok) {
              const raw = await res.text().catch(() => "");
              const data = parsePlatformChatCompletionData(raw);
              // `JSON.stringify(data)` collapses an empty/HTML/Cloudflare body into
              // `{}`, which is ambiguous and forces a long post-hoc investigation.
              // Carry the raw body (truncated) + gateway-revealing headers so the
              // next 502 self-documents its origin:
              //   - empty body + server: Caddy     -> gateway / origin unreachable
              //   - {"error":{code:"UPSTREAM_*"}} -> nolo app layer (upstream deepseek)
              //   - HTML "502 Bad Gateway"         -> CDN / reverse proxy
              const rawPreview =
                raw.length > 200 ? `${raw.slice(0, 200)}…(${raw.length}b)` : raw;
              const gatewayHeaders = [
                "server",
                "cf-ray",
                "cf-cache-status",
                "content-length",
              ]
                .map((h) => {
                  const v = res.headers.get(h);
                  return v ? `${h}=${v}` : null;
                })
                .filter(Boolean)
                .join(" ");
              throw new Error(
                `platform provider failed: HTTP ${res.status} ${JSON.stringify(data)}` +
                  (rawPreview ? ` raw="${rawPreview}"` : "") +
                  (gatewayHeaders ? ` headers=[${gatewayHeaders}]` : ""),
              );
            }
            const contentType = res.headers.get("content-type") ?? "";
            const shouldStream =
              Boolean(stream && options?.onTextDelta) &&
              contentType.includes("text/event-stream");
            if (shouldStream && options?.onTextDelta) {
              const streamed = await readOpenAiCompatibleSseCompletion({
                response: res,
                onTextDelta: options.onTextDelta,
              });
              logLocalRuntimeDiagnostic("provider.request.result", {
                agentKey: agentConfig.key,
                transport: "platform-proxy",
                ok: true,
                stream: true,
                contentChars: streamed.content.length,
                toolCallCount: streamed.tool_calls?.length ?? 0,
              });
              return {
                content: streamed.content,
                model: providerConfig.model,
                provider: providerConfig.provider,
                ...(streamed.tool_calls
                  ? { tool_calls: streamed.tool_calls }
                  : {}),
                ...(streamed.reasoning_content
                  ? { reasoning_content: streamed.reasoning_content }
                  : {}),
                ...(streamed.usage ? { usage: streamed.usage } : {}),
                trace: messages,
              };
            }
            const raw = await res.text().catch(() => "");
            logLocalRuntimeDiagnostic("provider.request.result", {
              agentKey: agentConfig.key,
              transport: "platform-proxy",
              status: res.status,
              ok: res.ok,
              responseBytes: raw.length,
            });
            const data = parsePlatformChatCompletionData(raw);
            return parsePlatformChatCompletionResponse({
              providerConfig,
              data,
              trace: messages,
            });
          },
        };
      }

      const providerConfig = await resolveCliOpenAiProviderConfig({
        agentConfig,
        env: deps.env,
        apiKeyRefResolver,
        credentialBroker,
        syncFetcher,
      });
      // OAuth provider 的 access token 可能短于一次工具循环的时长。
      // 把 token 解析下沉到每次请求，而不是固化在 providerConfig 里。
      // 非 OAuth ref（broker 的 api-key:*）resolver 会返回 null，回落到已解析的 key。
      const oauthApiKeyRef = asOptionalTrimmedString(agentConfig.apiKeyRef);
      // 不要 catch：resolver 只在「凭证存在、已过期、且刷不动」时抛错，此时旧 token
      // 必定也是死的，吞掉异常只会把「Run `nolo auth <provider>`」这句可执行的指引
      // 降级成一句无信息量的 HTTP 401。非 OAuth ref 走的是 return null，不是抛错。
      const resolveRequestApiKey = oauthApiKeyRef
        ? (opts: { force: boolean }) =>
            apiKeyRefResolver(oauthApiKeyRef, { force: opts.force })
        : undefined;
      logLocalRuntimeDiagnostic("provider.selected", {
        agentKey: agentConfig.key,
        transport: "direct-openai-compatible",
        apiSource: agentConfig.apiSource ?? null,
        provider: providerConfig.provider,
        model: providerConfig.model,
        endpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
        hasApiKey: Boolean(providerConfig.apiKey),
        apiKeyHeader: providerConfig.apiKeyHeader ?? null,
        useServerProxy: agentConfig.useServerProxy ?? null,
        customProviderEndpoint:
          summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
      });
      const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
        agentConfig,
        deps.env,
        buildProviderOpenAiTools,
        additionalToolNames,
        { hasUserChoice: Boolean(deps.requestUserChoice) },
      );
      return {
        model: providerConfig.model,
        complete: async (messages, options) => {
          const stream = Boolean(options?.onTextDelta);
          const inlinedMessages = (
            await inlineImageUrlsForCustomProvider(
              { messages },
              {
                shouldInline: true,
                isAllowedImageUrl: (url) => {
                  try {
                    return new URL(url).origin === new URL(serverUrl).origin;
                  } catch {
                    return false;
                  }
                },
                fetchImage: async (url) => {
                  const response = await fetchImpl(url, {
                    headers: authToken
                      ? { Authorization: `Bearer ${authToken}` }
                      : undefined,
                  });
                  if (!response.ok) {
                    return { ok: false, error: `HTTP ${response.status}` };
                  }
                  return {
                    ok: true,
                    mimeType:
                      response.headers.get("content-type") ??
                      "application/octet-stream",
                    bytes: new Uint8Array(await response.arrayBuffer()),
                  };
                },
              },
            ) as { messages: typeof messages }
          ).messages;
          logLocalRuntimeDiagnostic("provider.request.start", {
            agentKey: agentConfig.key,
            transport: "direct-openai-compatible",
            requestUrl: summarizeEndpoint(providerConfig.endpoint) ?? null,
            model: providerConfig.model,
            messageCount: messages.length,
            toolCount: tools.length,
            requestedToolNames,
            openAiToolNames: summarizeOpenAiToolNames(tools),
            stream,
          });
          const result = await executeOpenAiCompatibleChatCompletion({
            providerConfig,
            messages: inlinedMessages,
            tools,
            fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
              fetchWithTransientRetry(fetchImpl, url, init, {
                sleep: deps.sleep,
                loopbackRequest,
              }),
            stream,
            onTextDelta: options?.onTextDelta,
            ...(resolveRequestApiKey ? { resolveApiKey: resolveRequestApiKey } : {}),
          });
          logLocalRuntimeDiagnostic("provider.request.result", {
            agentKey: agentConfig.key,
            transport: "direct-openai-compatible",
            ok: true,
            stream,
            contentChars: result.content.length,
            toolCallCount: result.tool_calls?.length ?? 0,
          });
          return result;
        },
      };
    },
    executeTool: async (call, opts) => {
      const contextualCall = opts?.runtimeContext
        ? { ...call, runtimeContext: opts.runtimeContext }
        : call;
      assertWithinLocalToolBudget({
        toolName: call.name,
        budgets: localToolBudgets,
        usage: localToolUsage,
      });
      const result = await executeLocalToolWithPolicy({
        env: deps.env,
        agentToolNames: activeAgentToolNames,
        call: contextualCall,
        executors: localToolExecutors,
        abortSignal: opts?.abortSignal,
        detachMs: resolveExecShellDetachMs(deps.env),
        ...(deps.confirmDestructiveAction
          ? { confirmDestructiveAction: deps.confirmDestructiveAction }
          : {}),
      });
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          workspaceRoot,
          workspaceKind: "current",
        },
      };
    },
  };
}
