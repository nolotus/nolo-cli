import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeHostAdapter,
  AgentRuntimeSaveTurnInput,
} from "../agentRuntimeLocal";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeToolCall,
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "../../agent-runtime";
import type { PermissionRequest } from "../../agent-runtime/actionGate";

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
} from "../../agent-runtime/localDialogRead";
import type {
  LocalAgentTurnInput,
  LocalAgentTurnResult,
} from "../../agent-runtime/localLoop";
import type { CliKvDb, HybridRecordStore } from "./hybridRecordStore";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import { createTokenKey, dialogMessageRange } from "../../database/keys";
import { prepareTokenUsageData } from "../../ai/token/prepareTokenUsageData";
import {
  LOCAL_CODEX_AGENT_ID,
  LOCAL_CODEX_AGENT_KEY,
  NOLO_DEFAULT_AGENT_ID,
  NOLO_DEFAULT_AGENT_KEY,
} from "../agentAliases";
import { isCompiledBinary } from "../cliEnvHelpers";
import type { CliFetchImpl } from "../cliFetch";
import { clipCompactText } from "../../core/clipCompactText";
import type { CollapsedPasteStore } from "../../core/collapsedPaste";
import { normalizeAgentHandle } from "../../core/agentHandle";
import { toErrorMessage } from "../../core/errorMessage";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
import { asTrimmedString } from "../../core/trimmedString";
import { summarizeEndpoint } from "../../core/summarizeEndpoint";

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
  resolveLegacyDeepSeekProxyChatFallback,
  resolvePlatformChatProviderConfig,
  resolveCurrentRunRuntimeToolPolicy,
  resolveLocalWorkspaceExecutorOptionsFromPolicy,
  resolveRequestedRuntimeToolNames,
  resolveRuntimeToolSurfaceForAgent,
  shouldUsePlatformChatProvider,
  canUsePlatformChatProvider,
} from "../agentRuntimeLocal";
import { fetchAntigravityCloudCodeCompletion } from "../../agent-runtime/antigravityCloudCodeProvider";
import { isAntigravityOAuthAgent } from "../../agent-runtime/antigravityOAuth";
import {
  fetchAnthropicMessagesCompletion,
  isAnthropicOAuthAgent,
} from "../../agent-runtime/anthropicMessagesProvider";
import {
  createCursorProvider,
  isCursorOAuthAgent,
} from "../../agent-runtime/cursor/cursorProvider";
import { readOAuthCredential } from "../../agent-runtime/oauthTokenStore";
import { getDefaultCliLocalRuntimeDb } from "../localRuntimeDb";
import { resolveAgentRuntimeConfigFromRecord } from "./agentConfigResolver";
import { resolveCliOpenAiProviderConfig } from "./localProviderResolver";
import { createFileCredentialBroker } from "../../agent-runtime/fileCredentialBroker";
import { fetchServerSyncedCredential } from "../../ai/chat/agentCredentialSyncClient";
import { createOAuthApiKeyRefResolver } from "../oauth/apiKeyRefResolver";
import {
  buildLocalDialogWritePlan,
  localDialogMessageRecordToRuntimeMessage,
} from "./localDialogRecords";
import { generateLocalDialogTitle } from "../../agent-runtime/dialogTitleLlm";
import {
  buildLocalAgentLookupKeys,
  shouldReadAgentKeyRemotely,
} from "./localAgentRecords";
import { createCliHybridRecordStore } from "./hybridRecordStore";
import { executeLocalToolWithPolicy } from "./localToolPolicy";
import { inferCaptureIntent } from "../../ai/policy/runtimePolicy";
import {
  TOOL_PACKS,
  FORCED_TOOLS,
  applyDisabledTools,
  expandEnabledPacks,
  appendEnabledPackPromptPatches,
  addDefaultLightWebToolsForConfiguredAgents,
} from "../../ai/tools/toolPacks";
import { prepareTools } from "../../ai/tools/prepareTools";
import { canonicalizeToolNames } from "../../ai/tools/toolNameAliases";
import {
  buildNoloWorkspaceCliToolExecutors,
  buildNoloWorkspaceOpenAiTools,
  parseNoloWorkspaceToolArguments,
} from "../../agent-runtime/noloWorkspaceTools";
import {
  executeCli as defaultExecuteCli,
  CliProviderQuotaError,
} from "../../ai/agent/cliExecutor";
import { buildCliPrompt } from "../../ai/agent/cliPrompt";
import {
  readXhsProfileFunc,
  readXhsProfileFunctionSchema,
} from "../../ai/tools/readXhsProfileTool";
import {
  readXPostFunc,
  readXPostFunctionSchema,
} from "../../ai/tools/readXPostTool";
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

type PreparedAgentRuntime = {
  agentConfig: AgentRuntimeAgentConfig;
  activeAgentToolNames: string[];
  runtimeToolExecutionLimits: Record<string, unknown>;
  localToolExecutors: Record<
    string,
    (
      call: any,
    ) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  >;
};

const preparedAgentRuntimeCache = new Map<string, PreparedAgentRuntime>();
const hybridStoreCache = new Map<string, Promise<HybridRecordStore>>();

function normalizeRuntimeCacheCwd(cwd?: string) {
  return (cwd?.trim() || process.cwd()).replace(/\/+$/, "") || ".";
}

function buildPreparedAgentCacheKey(args: {
  userId: string;
  agentRef: string;
  cwd: string;
}) {
  return `${args.userId}\0${args.agentRef}\0${args.cwd}`;
}

export function clearCliLocalRuntimePreparedAgentCache() {
  preparedAgentRuntimeCache.clear();
  hybridStoreCache.clear();
}


type CliLocalRuntimeAdapterDeps = {
  env: EnvLike;
  db?: CliLocalRuntimeDb;
  store?: HybridRecordStore;
  now?: () => number;
  createId?: () => string;
  fetchImpl?: CliFetchImpl;
  cwd?: string;
  output?: { write(chunk: string): unknown };
  localToolExecutors?: Record<
    string,
    (
      call: any,
    ) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  >;
  readXPost?: ReadToolFn;
  readXhsProfile?: ReadToolFn;
  executeCli?: LocalCliExecutor;
  sleep?: (ms: number) => Promise<void>;
  loopbackRequest?: (input: FetchInput, init?: FetchInit) => Promise<Response>;
  buildProviderOpenAiTools?: typeof buildOpenAiTools;
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
  pastedTextStore?: CollapsedPasteStore;
};

async function defaultLocalRuntimeDb(): Promise<CliLocalRuntimeDb> {
  return getDefaultCliLocalRuntimeDb();
}

function createFallbackId() {
  return ulid();
}

function logLocalRuntimeDiagnostic(
  event: string,
  fields: Record<string, unknown>,
) {
  if (
    process.env.NOLO_LOCAL_RUNTIME_DEBUG !== "1" &&
    process.env.NOLO_DEBUG !== "1"
  ) {
    return;
  }
  console.error(`[nolo-local-runtime] ${event} ${JSON.stringify(fields)}`);
}

function summarizeOpenAiToolNames(tools: Array<Record<string, unknown>>) {
  return tools.reduce<string[]>((acc, tool) => {
    const fn = tool.function;
    const name =
      fn &&
      typeof fn === "object" &&
      "name" in fn &&
      typeof fn.name === "string"
        ? fn.name
        : null;
    if (name) acc.push(name);
    return acc;
  }, []);
}

// 导出供测试（localRuntimeAdapter.test.ts 的 policy 派生回归用）。
export function buildOpenAiTools(args: {
  agentKey?: string;
  toolNames?: string[];
  env: EnvLike;
}) {
  const toolset = buildLocalWorkspaceToolsetForEnv(args);
  const toolNameSet = new Set(args.toolNames ?? []);
  const callAgentTools = toolNameSet.has("callAgent")
    ? prepareTools(["callAgent"])
    : [];
  // ui_ask_choice 是纯交互工具，本地可直接执行；只要 agent 声明了就注入。
  const uiAskChoiceTools = toolNameSet.has("ui_ask_choice")
    ? prepareTools(["ui_ask_choice"])
    : [];
  const readPastedTextTools = toolNameSet.has("readPastedText")
    ? [
        {
          type: "function",
          function: {
            name: "readPastedText",
            description:
              "Read a chunk of a large TUI paste by pasteId. Use startLine and endLine to page through the full content.",
            parameters: {
              type: "object",
              properties: {
                pasteId: {
                  type: "integer",
                  minimum: 1,
                  description: "The paste id from the user message reference.",
                },
                startLine: {
                  type: "integer",
                  minimum: 1,
                  description: "First 1-based line to return; defaults to 1.",
                },
                endLine: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "Last 1-based line to return; each call is bounded to a 200-line chunk.",
                },
              },
              required: ["pasteId"],
              additionalProperties: false,
            },
          },
        },
      ]
    : [];
  return [
    ...callAgentTools,
    ...uiAskChoiceTools,
    ...readPastedTextTools,
    ...buildLocalWorkspaceOpenAiTools({
      toolNames: toolset.toolNames,
      exposeShellTools: toolset.exposeShellTools,
      listFilesDescriptionVariant: resolveListFilesDescriptionVariant(args.env),
      listFilesParameterVariant: resolveListFilesParameterVariant(args.env),
      readFileDescriptionVariant: resolveReadFileDescriptionVariant(args.env),
      readFileParameterVariant: resolveReadFileParameterVariant(args.env),
      globFilesDescriptionVariant: resolveGlobFilesDescriptionVariant(args.env),
      globFilesParameterVariant: resolveGlobFilesParameterVariant(args.env),
      searchFilesDescriptionVariant: resolveSearchFilesDescriptionVariant(
        args.env,
      ),
      searchFilesParameterVariant: resolveSearchFilesParameterVariant(args.env),
    }),
    ...buildServerPlatformOpenAiTools({ toolNames: args.toolNames }),
    ...buildNoloWorkspaceOpenAiTools({ toolNames: args.toolNames }),
    // startAgentRun/controlAgentRun：CLI 本地 --bg 执行器已就绪（MED-1 修复，
    // cliAgentRunToolExecutors），只要 agent 声明（agent-orchestration 包展开）
    // 就注入 schema。
    ...prepareTools(
      ["startAgentRun", "controlAgentRun"].filter((name) => toolNameSet.has(name)),
    ),
  ];
}

/**
 * CLI-side default tools: auto-injected so every agent gets the baseline
 * interaction + web-search capability without declaring it.
 *
 * Split into two tiers:
 * - FORCED_TOOLS (from toolPacks): always injected, even in declared-only mode.
 *   These are the platform interaction floor (e.g. ui_ask_choice — an agent
 *   that cannot ask the user a question is not usable).
 * - CLI_DEFAULT_TOOLS: injected in normal mode, skipped in declared-only mode
 *   (ablation / explicit-tool-only runs). These need server proxy config to
 *   actually execute, so they are opt-out-able rather than forced.
 */
const CLI_DEFAULT_TOOLS = ["exa_search", "fetchWebpage"] as const;

/**
 * Inject forced + default CLI tools. Forced tools survive declared-only mode;
 * default tools do not. Mirrors web's getRuntimeCoreTools() for the subset of
 * CORE tools that have a local CLI executor.
 */
function addDefaultCliCoreTools(
  toolNames: string[],
  env?: EnvLike,
): string[] {
  const declaredOnly = env && shouldUseDeclaredOnlyLocalWorkspaceTools(env);
  // Forced tools are always present; default tools only in normal mode.
  const injected = declaredOnly
    ? [...FORCED_TOOLS]
    : [...FORCED_TOOLS, ...CLI_DEFAULT_TOOLS];
  return [...new Set([...toolNames, ...injected])];
}

/**
 * CLI 端默认开 code + agent-orchestration + skills 能力包：enabledPacks 为空时
 * 补 ["code", "agent-orchestration", "skills"]，保持「CLI agent 默认能改代码、
 * 默认具备多 agent 编排（含 listAgents 发现）与技能加载」的体感，但走显式能力包而非隐式兜底
 * （DEFAULT_LOCAL_CODING_TOOL_NAMES 已删除）。
 *
 * 与桌面端 resolveDesktopEffectiveEnabledPacks 区别：桌面端只在绑文件夹时补；
 * CLI 端因为没有 workspace 授权概念，对 enabledPacks 为空的 agent 一律补——
 * 除非 declaredOnly=true（用户显式要 ablation，不补任何包）。
 *
 * 纯函数，单独可测。
 */
export function resolveCliEffectiveEnabledPacks(args: {
  enabledPacks?: string[] | null;
  declaredOnly?: boolean;
}): string[] {
  if (args.declaredOnly === true) {
    return args.enabledPacks ?? [];
  }
  const base = args.enabledPacks ?? [];
  if (base.length === 0) {
    return ["code", "agent-orchestration", "skills"];
  }
  // 非空也幂等补齐编排包与技能包：所有 CLI agent 默认具备多 agent 编排（含
  // listAgents 发现）与技能加载（loadSkill/readSkillDoc），关闭通道走 disabledTools。
  const withOrchestration = base.includes("agent-orchestration")
    ? base
    : [...base, "agent-orchestration"];
  return withOrchestration.includes("skills")
    ? withOrchestration
    : [...withOrchestration, "skills"];
}

/**
 * 把 rawRecord 里被 resolveAgentRuntimeConfigFromRecord 丢弃的 enabledPacks 补回
 * config，并把启用能力包的 promptPatch（方法论文档）追加进 agent prompt。
 * CLI 端 system prompt 直用 agentConfig.prompt、工具展开读 agentConfig.enabledPacks，
 * 两处都依赖这份回补；与 web 端 skillPromptPatches 注入链对齐。无 patch 时原样返回。
 */
function withRuntimeEnabledPacksAndPrompt(
  config: AgentRuntimeAgentConfig,
): AgentRuntimeAgentConfig {
  const rawRecord = (config as unknown as { rawRecord?: Record<string, unknown> })
    .rawRecord ?? {};
  const enabledPacks =
    (config as unknown as { enabledPacks?: string[] }).enabledPacks ??
    (rawRecord.enabledPacks as string[] | undefined);
  const prompt = appendEnabledPackPromptPatches(
    (config as { prompt?: string }).prompt,
    enabledPacks,
  );
  if (
    prompt === (config as { prompt?: string }).prompt &&
    !enabledPacks?.length
  ) {
    return config;
  }
  return {
    ...config,
    ...(enabledPacks?.length ? { enabledPacks } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/**
 * CLI 端 requestedToolNames 管道：expandEnabledPacks → canonicalize →
 * addDefaultCliCoreTools → addDefaultLightWebToolsForConfiguredAgents → applyDisabledTools。
 * resolveProviderOpenAiToolBundle 和 loadAgentConfig 两条路径共用，避免重复。
 */
// 导出供测试（localRuntimeAdapter.test.ts 的 policy 派生回归用）。
export function resolveCliRequestedToolNames(
  agentConfig: AgentRuntimeAgentConfig,
  env: EnvLike,
): string[] {
  const declaredOnly = shouldUseDeclaredOnlyLocalWorkspaceTools(env);
  return applyDisabledTools(
    addDefaultLightWebToolsForConfiguredAgents(
      addDefaultCliCoreTools(
        canonicalizeToolNames(
          expandEnabledPacks(
            // CLI 端默认开 code 能力包：enabledPacks 为空时补 ["code"]，保持
            // 「CLI agent 默认能改代码」的体感，但走显式能力包而非隐式兜底
            // （DEFAULT_LOCAL_CODING_TOOL_NAMES 已删除）。
            // declared-only 模式下不补——用户显式要 ablation。
            resolveCliEffectiveEnabledPacks({
              enabledPacks: (agentConfig as any)?.enabledPacks,
              declaredOnly,
            }),
            resolveRequestedRuntimeToolNames({ agentConfig }),
          ),
        ),
        env,
      ),
      agentConfig,
    ),
    (agentConfig as any)?.disabledTools,
  );
}

function resolveProviderOpenAiToolBundle(
  agentConfig: AgentRuntimeAgentConfig,
  env: EnvLike,
  buildTools: typeof buildOpenAiTools = buildOpenAiTools,
  additionalToolNames: string[] = [],
) {
  const requestedToolNames = [
    ...new Set([
      ...resolveCliRequestedToolNames(agentConfig, env),
      ...additionalToolNames,
    ]),
  ];
  const tools = buildTools({
    agentKey: agentConfig.key,
    toolNames: requestedToolNames,
    env,
  });
  return { requestedToolNames, tools };
}

function buildLocalWorkspaceToolsetForEnv(args: {
  toolNames?: string[];
  env: EnvLike;
}) {
  const toolset = buildLocalWorkspaceToolset({
    declaredToolNames: args.toolNames,
    exposeShellTools: true,
    useDeclaredToolNamesOnly: shouldUseDeclaredOnlyLocalWorkspaceTools(
      args.env,
    ),
  });
  return toolset;
}

// Policy 名单直接派生自 schema 侧暴露的工具名，不再按类别独立收集。
// 理由：policy 的「agent 有没有声明这个工具」检查，语义就是「模型不能调
// 我没给它的工具」，唯一权威真值就是 buildOpenAiTools 的 schema 列表。
// 重新推导第二份名单必然漂移（startAgentRun/controlAgentRun 就是因此掉出
// 放行名单）。复用 summarizeOpenAiToolNames 提取 function.name，再去重。
// 导出供测试（localRuntimeAdapter.test.ts 的 policy 派生回归用）。
export function buildLocalPolicyToolNames(args: {
  agentKey?: string;
  toolNames?: string[];
  env: EnvLike;
  /**
   * schema 构造器，默认用模块级 buildOpenAiTools。
   *
   * 注意 deps.buildProviderOpenAiTools 这个注入口：把它透传进来会让
   * policy 与 provider 用同一个构造器，理论上更严格，但代价是每个 prepared
   * runtime 多构造一次工具表，并且会打破既有的
   * 「builds provider OpenAI tools once per resolveProvider」性能守卫。
   * 该注入口目前只有测试在用，且注入的是比默认更窄的工具表（方向安全：
   * policy 宽于 schema 只会多放行没暴露的名字，不会误拒模型看得到的工具）。
   * 若将来有生产代码注入**更宽**的构造器，必须改走透传，否则漂移复现。
   */
  buildTools?: typeof buildOpenAiTools;
}) {
  const buildTools = args.buildTools ?? buildOpenAiTools;
  return [
    ...new Set(
      summarizeOpenAiToolNames(
        buildTools({
          agentKey: args.agentKey,
          toolNames: args.toolNames,
          env: args.env,
        }) as Array<Record<string, unknown>>,
      ),
    ),
  ];
}

function buildServerPlatformOpenAiTools(args: { toolNames?: string[] }) {
  const toolNameSet = new Set(args.toolNames ?? []);
  const tableTools = prepareTools(
    Array.from(toolNameSet).filter((name) =>
      LOCAL_SERVER_TABLE_TOOL_NAME_SET.has(name),
    ),
  );
  const webTools = prepareTools(
    Array.from(toolNameSet).filter((name) =>
      LOCAL_SERVER_WEB_TOOL_NAME_SET.has(name),
    ),
  );
  return [
    ...(toolNameSet.has("read_xhs_profile")
      ? [
          {
            type: "function",
            function: readXhsProfileFunctionSchema,
          },
        ]
      : []),
    ...(toolNameSet.has("read_x_post")
      ? [
          {
            type: "function",
            function: readXPostFunctionSchema,
          },
        ]
      : []),
    ...tableTools,
    ...webTools,
  ];
}

export type CliCallAgentToolExecutorContext = {
  createChildAdapter: (context: {
    dialogId: string;
    spaceId?: string;
    runtimeContext: Record<string, any>;
  }) => AgentRuntimeHostAdapter;
  runChildTurn: (input: LocalAgentTurnInput) => Promise<LocalAgentTurnResult>;
  dialogId?: string;
  spaceId?: string;
  runtimeContext?: Record<string, any> | null;
};

export function createCliCallAgentToolExecutor(
  deps: CliLocalRuntimeAdapterDeps,
  ctx: CliCallAgentToolExecutorContext,
): (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult> {
  const userId = resolveLocalUserId(deps.env);
  const workspaceRoot = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? createFallbackId;

  return async (call) => {
    const parsed = parseNoloWorkspaceToolArguments(call.arguments);
    const agentKey = asTrimmedString(parsed.agentKey);
    const task = asTrimmedString(parsed.task);

    if (!agentKey) {
      return {
        content: JSON.stringify({ error: "callAgent: agentKey is required" }),
        metadata: { callAgent: true },
      };
    }
    if (!task) {
      return {
        content: JSON.stringify({ error: "callAgent: task is required" }),
        metadata: { callAgent: true },
      };
    }

    const allowedChildAgentKeys = asTrimmedNonEmptyStringArray(
      ctx.runtimeContext?.allowedChildAgentKeys,
    );
    if (
      allowedChildAgentKeys.length > 0 &&
      !allowedChildAgentKeys.includes(agentKey)
    ) {
      return {
        content: JSON.stringify({
          error:
            "callAgent: agentKey is not allowed by parent runtimeContext.allowedChildAgentKeys",
          agentKey,
          allowedChildAgentKeys,
        }),
        metadata: { callAgent: true },
      };
    }

    const background = parsed.background === true;
    const parentDialogId = asOptionalTrimmedString(ctx.dialogId);
    const parentThreadId =
      parentDialogId ??
      asOptionalTrimmedString(ctx.runtimeContext?.parentThreadId);
    const rootThreadId =
      asOptionalTrimmedString(ctx.runtimeContext?.rootThreadId) ??
      asOptionalTrimmedString(ctx.runtimeContext?.parentThreadId) ??
      parentThreadId;
    const presentationIntent = background
      ? "background_handoff"
      : "inline_result";
    const threadKind = background ? "background" : "inline";

    const childRuntimeContext = {
      ...(ctx.runtimeContext ?? {}),
      surface: "cli",
      entrypoint: "agent-tool:callAgent",
      threadKind,
      presentationIntent,
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(rootThreadId ? { rootThreadId } : {}),
      workspaceRoot,
      workspaceKind: "current",
      workspaceAccess: "inherited",
    };

    const childDialogId = createId();
    const store = await getOrCreateSharedStore(deps);
    await persistCliPendingChildDialog({
      store,
      userId,
      dialogId: childDialogId,
      agentKey,
      title: task,
      spaceId: ctx.spaceId,
      parentDialogId,
      rootDialogId: rootThreadId,
      workspaceRoot,
      background,
      now: now(),
    });

    const childAdapter = ctx.createChildAdapter({
      dialogId: childDialogId,
      spaceId: ctx.spaceId,
      runtimeContext: childRuntimeContext,
    });
    const childInputBase: LocalAgentTurnInput = {
      adapter: childAdapter,
      agentRef: agentKey,
      input: buildDelegatedTaskContent(task, parsed.input),
      runtimeContext: childRuntimeContext,
      spaceId: ctx.spaceId,
      continueDialogId: childDialogId,
      parentDialogId,
    };

    if (background) {
      void ctx.runChildTurn(childInputBase).catch(async (error) => {
        const errorMessage = toErrorMessage(error);
        try {
          await persistCliFailedChildDialog({
            store,
            userId,
            dialogId: childDialogId,
            errorMessage,
            now: now(),
          });
        } catch (persistError) {
          deps.output?.write(
            `[nolo] failed to persist background child failure: ${toErrorMessage(
              persistError,
            )}\n`,
          );
        }
      });

      return {
        content: JSON.stringify({
          success: true,
          status: "pending",
          agentKey,
          childDialogId,
          ...(parentDialogId ? { parentDialogId } : {}),
        }),
        metadata: { callAgent: true, background: true, localRuntime: true },
      };
    }

    try {
      const childResult = await ctx.runChildTurn(childInputBase);
      return {
        content: JSON.stringify({
          success: true,
          agentKey,
          dialogId: childDialogId,
          model: childResult.model ?? null,
          provider: childResult.provider ?? null,
          content: childResult.content ?? "",
          usage: childResult.usage ?? null,
        }),
        metadata: { callAgent: true, background: false, localRuntime: true },
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      try {
        await persistCliFailedChildDialog({
          store,
          userId,
          dialogId: childDialogId,
          errorMessage,
          now: now(),
        });
      } catch (persistError) {
        deps.output?.write(
          `[nolo] failed to persist foreground child failure: ${toErrorMessage(
            persistError,
          )}\n`,
        );
      }
      return {
        content: JSON.stringify({
          success: false,
          agentKey,
          dialogId: childDialogId,
          error: errorMessage,
        }),
        metadata: {
          callAgent: true,
          background: false,
          localRuntime: true,
          error: true,
        },
      };
    }
  };
}


async function resolveStore(deps: CliLocalRuntimeAdapterDeps) {
  if (deps.store) return deps.store;
  return createCliHybridRecordStore({
    db: deps.db ?? (await defaultLocalRuntimeDb()),
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
}

async function getOrCreateSharedStore(deps: CliLocalRuntimeAdapterDeps) {
  if (deps.store) return deps.store;
  const cacheKey = normalizeRuntimeCacheCwd(deps.cwd);
  let storePromise = hybridStoreCache.get(cacheKey);
  if (!storePromise) {
    storePromise = resolveStore(deps);
    hybridStoreCache.set(cacheKey, storePromise);
  }
  return storePromise;
}

function createLocalDialogTitleGenerator(
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

/**
 * Persist a token usage record for a CLI-local agent run.
 *
 * Reuses `prepareTokenUsageData` (which internally calls `normalizeUsage`) so
 * the billing/normalization logic has a single source of truth. The record is
 * written with the same key layout (`createTokenKey.record`) as web/server
 * paths so downstream report readers (e.g. `buildCacheHitReport`) work
 * without modification.
 *
 * Safety: `apiSource: "cli"` guarantees `resolveBillable` returns `false` —
 * local runs are user-owned subscriptions and must never produce billable
 * records.
 *
 * Failure here is non-fatal: token records are observability data; dialog
 * persistence (user data) takes priority. Errors are logged, never thrown.
 */
async function writeLocalTokenRecord(args: {
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

async function writeDialog(args: {
  store: HybridRecordStore;
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  now: () => number;
  createId: () => string;
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  output?: { write(chunk: string): unknown };
  cwd?: string;
  /**
   * Optional async title generator for new dialogs.
   * Only invoked when: (1) user is logged in, (2) existing dialog has no title.
   * Returns a title string, or null/empty to use the built-in fallback.
   */
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

  // Login gate: only logged-in users get LLM-generated titles.
  // Unauthenticated runs fall back to the built-in resolveDialogTitle.
  const authToken = resolveRuntimeAuthToken(args.env);
  const isLoggedIn = Boolean(authToken && parseUserIdFromAuthToken(authToken));
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
      // Falls back to built-in resolveDialogTitle inside buildLocalDialogWritePlan.
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

  // Persist token usage record (observability). Non-fatal: dialog is already
  // saved above; a token write failure must never surface to the caller.
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

  // Sync all local turns to the configured server, unless the user is "local"
  // (device-local hard boundary — server write routes reject userId "local").
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
        // Non-subjectRefs turns: no output when no server/token is configured.
      }
    } catch (error) {
      if (hasSubjectRefs) {
        // SubjectRefs evidence contract: failure must propagate.
        throw error;
      }
      // Normal turn: sync failure is non-fatal, just warn.
      args.output?.write(
        `[nolo] Remote dialog evidence sync failed; local dialog only: ${toErrorMessage(
          error,
        )}\n`,
      );
    }
  }
  return { dialogId: plan.dialogId };
}

function resolveCliDialogRecordKey(userId: string, dialogId: string): string {
  // continueDialogId / loadDialogHistory 用的是裸 dialogId；dialog 记录 key 带 userId。
  if (dialogId.startsWith("dialog-") && !dialogId.includes("-msg-")) {
    return dialogId;
  }
  return `dialog-${userId}-${dialogId}`;
}

async function loadCliDialogSummary(args: {
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

async function saveCliDialogSummary(args: {
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
      const cacheKey = buildPreparedAgentCacheKey({
        userId,
        agentRef,
        cwd: normalizeRuntimeCacheCwd(workspaceRoot),
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
      const requestedToolNames = agentConfig
        ? resolveCliRequestedToolNames(agentConfig, deps.env)
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
        ...runtimeToolExecutionLimits,
      });
      if (agentConfig && !deps.pastedTextStore) {
        preparedAgentRuntimeCache.set(cacheKey, {
          agentConfig,
          activeAgentToolNames,
          runtimeToolExecutionLimits,
          localToolExecutors,
        });
      }
      return agentConfig;
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
              },
            );
            let responseProviderConfig = providerConfig;
            let firstErrorRaw: string | undefined;
            if (!res.ok) {
              firstErrorRaw = await res.text().catch(() => "");
              const fallbackProviderConfig =
                resolveLegacyDeepSeekProxyChatFallback({
                  providerConfig,
                  status: res.status,
                  raw: firstErrorRaw,
                });
              if (fallbackProviderConfig) {
                responseProviderConfig = fallbackProviderConfig;
                const fallbackRequest = buildPlatformChatCompletionRequest({
                  providerConfig: fallbackProviderConfig,
                  messages,
                  tools,
                  stream: false,
                });
                logLocalRuntimeDiagnostic("provider.request.compatibility-fallback", {
                  agentKey: agentConfig.key,
                  provider: providerConfig.provider,
                  fromEndpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
                  toEndpoint:
                    summarizeEndpoint(fallbackProviderConfig.endpoint) ?? null,
                  reason: "legacy-proxy-responses-schema",
                });
                res = await fetchWithTransientRetry(
                  fetchImpl,
                  fallbackRequest.url,
                  { ...fallbackRequest.init },
                  {
                    sleep: deps.sleep,
                    loopbackRequest,
                  },
                );
                firstErrorRaw = undefined;
              }
            }
            if (!res.ok) {
              const raw =
                firstErrorRaw ?? (await res.text().catch(() => ""));
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
              providerConfig: responseProviderConfig,
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
      );
      return {
        model: providerConfig.model,
        complete: async (messages, options) => {
          const stream = Boolean(options?.onTextDelta);
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
            messages,
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
    executeTool: async (call, opts?: { abortSignal?: AbortSignal }) => {
      assertWithinLocalToolBudget({
        toolName: call.name,
        budgets: localToolBudgets,
        usage: localToolUsage,
      });
      const result = await executeLocalToolWithPolicy({
        env: deps.env,
        agentToolNames: activeAgentToolNames,
        call,
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
