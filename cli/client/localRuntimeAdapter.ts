import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeHostAdapter,
  AgentRuntimeSaveTurnInput,
} from "../agentRuntimeLocal";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
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
export type UserChoiceOption = {
  id?: string;
  label: string;
  userMessage?: string;
};

export type UserChoiceRequest = {
  question: string;
  choices: UserChoiceOption[];
  blocking: boolean;
};

export type UserChoiceResult =
  | { kind: "selected"; userMessage: string; label: string }
  | { kind: "cancelled" };
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
import { dialogMessageRange } from "../../database/keys";
import {
  LOCAL_CODEX_AGENT_ID,
  LOCAL_CODEX_AGENT_KEY,
  NOLO_DEFAULT_AGENT_ID,
  NOLO_DEFAULT_AGENT_KEY,
} from "../agentAliases";
import { isCompiledBinary } from "../cliEnvHelpers";
import type { CliFetchImpl } from "../cliFetch";
import { clipCompactText } from "../../core/clipCompactText";
import { normalizeAgentHandle } from "../../core/agentHandle";
import { toErrorMessage } from "../../core/errorMessage";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
import { asTrimmedString } from "../../core/trimmedString";
import { summarizeEndpoint } from "../../core/summarizeEndpoint";

/**
 * Heavy agent-runtime / AI / local-DB modules are intentionally NOT top-level
 * imported. Help and other light CLI paths import this file only for
 * `clearCliLocalRuntimePreparedAgentCache` / builtin agent helpers; loading the
 * full runtime graph on every `nolo --help` was ~300ms. Modules are require()'d
 * on first real local-runtime use via ensureHeavyCliLocalRuntimeModules().
 *
 * Paths below must remain present as string literals for source-contract tests
 * (e.g. fileCredentialBroker wiring).
 */
const requireFromAdapter = createRequire(import.meta.url);

type CliExecuteResult = {
  text: string;
  raw?: string;
  elapsed?: number;
};
type CliImageInput = { source: string };
type ReadToolFn = (
  args: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ rawData: unknown; displayData?: unknown }>;

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
  pushLocalDialogToRemote,
  ensureDialogSyncedForServerFallback,
  prepareRemoteDialogEvidenceRecord,
} from "./cliRemoteDialogSync";
// Re-export for test/external compatibility (agentRun.ts imports from localRuntimeAdapter).
export {
  ensureDialogSyncedForServerFallback,
  pushLocalDialogToRemote,
  postRemoteRecord,
  syncLocalDialogEvidenceToRemote,
  prepareRemoteDialogEvidenceRecord,
} from "./cliRemoteDialogSync";
// Resolve at call-site level — the helpers module owns the canonical implementations.
const resolveRuntimeServerUrl = _resolveRuntimeServerUrl;
const resolveRuntimeAuthToken = _resolveRuntimeAuthToken;
const remoteDialogSyncTimeout = _remoteDialogSyncTimeout;

type FetchInput = string | URL | Request;
type FetchInit = RequestInit;
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

// Populated by ensureHeavyCliLocalRuntimeModules() before any local-run path.
let buildLocalWorkspacePolicyToolNames: any;
let buildLocalWorkspaceToolset: any;
let buildLocalWorkspaceOpenAiTools: any;
let executeOpenAiCompatibleChatCompletion: any;
let readOpenAiCompatibleSseCompletion: any;
let buildPlatformChatCompletionRequest: any;
let createLocalWorkspaceToolExecutors: any;
let parsePlatformChatCompletionData: any;
let parsePlatformChatCompletionResponse: any;
let resolvePlatformChatProviderConfig: any;
let resolveCurrentRunRuntimeToolPolicy: any;
let resolveLocalWorkspaceExecutorOptionsFromPolicy: any;
let resolveRequestedRuntimeToolNames: any;
let resolveRuntimeToolSurfaceForAgent: any;
let shouldUsePlatformChatProvider: any;
let canUsePlatformChatProvider: any;
let fetchAntigravityCloudCodeCompletion: any;
let isAntigravityOAuthAgent: any;
let fetchAnthropicMessagesCompletion: any;
let isAnthropicOAuthAgent: any;
let readOAuthCredential: any;
let getDefaultCliLocalRuntimeDb: any;
let resolveAgentRuntimeConfigFromRecord: any;
let resolveCliOpenAiProviderConfig: any;
let createFileCredentialBroker: any;
let fetchServerSyncedCredential: any;
let createOAuthApiKeyRefResolver: any;
let buildLocalDialogWritePlan: any;
let localDialogMessageRecordToRuntimeMessage: any;
let generateLocalDialogTitle: any;
let buildLocalAgentLookupKeys: any;
let shouldReadAgentKeyRemotely: any;
let createCliHybridRecordStore: any;
let executeLocalToolWithPolicy: any;
let inferCaptureIntent: any;
let TOOL_PACKS: any;
let canonicalizeToolNames: any;
let FORCED_TOOLS: any;
let applyDisabledTools: any;
let expandEnabledPacks: any;
let addDefaultLightWebToolsForConfiguredAgents: any;
let prepareTools: any;
let buildNoloWorkspaceCliToolExecutors: any;
let buildNoloWorkspaceOpenAiTools: any;
let filterNoloWorkspaceToolNames: any;
let parseNoloWorkspaceToolArguments: any;
let defaultExecuteCli: any;
let CliProviderQuotaError: any;
let buildCliPrompt: any;
let readXhsProfileFunc: ReadToolFn;
let readXhsProfileFunctionSchema: any;
let readXPostFunc: ReadToolFn;
let readXPostFunctionSchema: any;
let ulid: () => string;

let heavyCliLocalRuntimeModulesLoaded = false;

function ensureHeavyCliLocalRuntimeModules() {
  if (heavyCliLocalRuntimeModulesLoaded) return;
  heavyCliLocalRuntimeModulesLoaded = true;

  const agentRuntimeLocal = requireFromAdapter("../agentRuntimeLocal.ts");
  buildLocalWorkspacePolicyToolNames =
    agentRuntimeLocal.buildLocalWorkspacePolicyToolNames;
  buildLocalWorkspaceToolset = agentRuntimeLocal.buildLocalWorkspaceToolset;
  buildLocalWorkspaceOpenAiTools =
    agentRuntimeLocal.buildLocalWorkspaceOpenAiTools;
  executeOpenAiCompatibleChatCompletion =
    agentRuntimeLocal.executeOpenAiCompatibleChatCompletion;
  readOpenAiCompatibleSseCompletion =
    agentRuntimeLocal.readOpenAiCompatibleSseCompletion;
  buildPlatformChatCompletionRequest =
    agentRuntimeLocal.buildPlatformChatCompletionRequest;
  createLocalWorkspaceToolExecutors =
    agentRuntimeLocal.createLocalWorkspaceToolExecutors;
  parsePlatformChatCompletionData =
    agentRuntimeLocal.parsePlatformChatCompletionData;
  parsePlatformChatCompletionResponse =
    agentRuntimeLocal.parsePlatformChatCompletionResponse;
  resolvePlatformChatProviderConfig =
    agentRuntimeLocal.resolvePlatformChatProviderConfig;
  resolveCurrentRunRuntimeToolPolicy =
    agentRuntimeLocal.resolveCurrentRunRuntimeToolPolicy;
  resolveLocalWorkspaceExecutorOptionsFromPolicy =
    agentRuntimeLocal.resolveLocalWorkspaceExecutorOptionsFromPolicy;
  resolveRequestedRuntimeToolNames =
    agentRuntimeLocal.resolveRequestedRuntimeToolNames;
  resolveRuntimeToolSurfaceForAgent =
    agentRuntimeLocal.resolveRuntimeToolSurfaceForAgent;
  shouldUsePlatformChatProvider =
    agentRuntimeLocal.shouldUsePlatformChatProvider;
  canUsePlatformChatProvider =
    agentRuntimeLocal.canUsePlatformChatProvider;

  ({ fetchAntigravityCloudCodeCompletion } = requireFromAdapter(
    "../../agent-runtime/antigravityCloudCodeProvider.ts",
  ));
  ({ isAntigravityOAuthAgent } = requireFromAdapter(
    "../../agent-runtime/antigravityOAuth.ts",
  ));
  ({ fetchAnthropicMessagesCompletion, isAnthropicOAuthAgent } = requireFromAdapter(
    "../../agent-runtime/anthropicMessagesProvider.ts",
  ));
  ({ readOAuthCredential } = requireFromAdapter(
    "../../agent-runtime/oauthTokenStore.ts",
  ));
  ({ getDefaultCliLocalRuntimeDb } = requireFromAdapter(
    "../localRuntimeDb.ts",
  ));
  ({ resolveAgentRuntimeConfigFromRecord } = requireFromAdapter(
    "./agentConfigResolver.ts",
  ));
  ({ resolveCliOpenAiProviderConfig } = requireFromAdapter(
    "./localProviderResolver.ts",
  ));
  ({ createFileCredentialBroker } = requireFromAdapter(
    "../../agent-runtime/fileCredentialBroker.ts",
  ));
  ({ fetchServerSyncedCredential } = requireFromAdapter(
    "../../ai/chat/agentCredentialSyncClient.ts",
  ));
  ({ createOAuthApiKeyRefResolver } = requireFromAdapter(
    "../oauth/apiKeyRefResolver.ts",
  ));
  ({ buildLocalDialogWritePlan, localDialogMessageRecordToRuntimeMessage } =
    requireFromAdapter("./localDialogRecords.ts"));
  ({ generateLocalDialogTitle } = requireFromAdapter(
    "../../agent-runtime/dialogTitleLlm.ts",
  ));
  ({ buildLocalAgentLookupKeys, shouldReadAgentKeyRemotely } =
    requireFromAdapter("./localAgentRecords.ts"));
  ({ createCliHybridRecordStore } = requireFromAdapter(
    "./hybridRecordStore.ts",
  ));
  ({ executeLocalToolWithPolicy } = requireFromAdapter("./localToolPolicy.ts"));
  ({ inferCaptureIntent } = requireFromAdapter(
    "../../ai/policy/runtimePolicy.ts",
  ));
  ({ TOOL_PACKS, FORCED_TOOLS, applyDisabledTools, expandEnabledPacks, addDefaultLightWebToolsForConfiguredAgents } = requireFromAdapter("../../ai/tools/toolPacks.ts"));
  ({ prepareTools } = requireFromAdapter("../../ai/tools/prepareTools.ts"));
  ({ canonicalizeToolNames } = requireFromAdapter("../../ai/tools/toolNameAliases.ts"));
  ({
    buildNoloWorkspaceCliToolExecutors,
    buildNoloWorkspaceOpenAiTools,
    filterNoloWorkspaceToolNames,
    parseNoloWorkspaceToolArguments,
  } = requireFromAdapter("../../agent-runtime/noloWorkspaceTools.ts"));
  const cliExecutor = requireFromAdapter("../../ai/agent/cliExecutor.ts");
  defaultExecuteCli = cliExecutor.executeCli;
  CliProviderQuotaError = cliExecutor.CliProviderQuotaError;
  ({ buildCliPrompt } = requireFromAdapter("../../ai/agent/cliPrompt.ts"));
  ({ readXhsProfileFunc, readXhsProfileFunctionSchema } = requireFromAdapter(
    "../../ai/tools/readXhsProfileTool.ts",
  ));
  ({ readXPostFunc, readXPostFunctionSchema } = requireFromAdapter(
    "../../ai/tools/readXPostTool.ts",
  ));
  ({ ulid } = requireFromAdapter("ulid"));
}

const TRANSIENT_FETCH_MAX_ATTEMPTS = 3;
const TRANSIENT_FETCH_RETRY_BASE_DELAY_MS = 250;
// Max wait for remote dialog-evidence sync fetches (POST write / GET read)
// before aborting, so an unreachable/hung server cannot stall a turn.
export const BUILTIN_NOLO_AGENT_KEY = NOLO_DEFAULT_AGENT_KEY;
const BUILTIN_NOLO_AGENT_ID = NOLO_DEFAULT_AGENT_ID;
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
const LOCAL_SERVER_TABLE_TOOL_NAMES = [
  "createTable",
  "addTableRow",
  "addTableRows",
  "updateTableRow",
  "updateTableRows",
] as const;
const LOCAL_SERVER_TABLE_TOOL_NAME_SET = new Set<string>(
  LOCAL_SERVER_TABLE_TOOL_NAMES,
);

/**
 * Web access tools the CLI local runtime proxies through the nolo server
 * (same routes the desktop runtime uses: /api/fetch-webpage, /api/exa-search).
 * The CLI has no local EXA/FIRECRAWL keys, so these always bridge to a server
 * that has them configured. Requires NOLO_SERVER_URL + auth token at runtime.
 */
const LOCAL_SERVER_WEB_TOOL_NAMES = ["fetchWebpage", "exa_search"] as const;
const LOCAL_SERVER_WEB_TOOL_NAME_SET = new Set<string>(
  LOCAL_SERVER_WEB_TOOL_NAMES,
);

// ============================================================================
// CLI tool classification — single source of truth for "which tools belong
// to which category". Previously each consumer (addDefaultLightWebTools,
// buildLocalPolicyToolNames, buildServerPlatformOpenAiTools, buildOpenAiTools)
// re-hardcoded the same name lists with slight drift. All four now read these
// sets.
// ============================================================================

/** Tools whose schema is injected from the nolo tool registry (not workspace). */
const REGISTRY_INJECTED_TOOL_NAMES = new Set<string>([
  "callAgent",
  "ui_ask_choice",
  "read_x_post",
  "read_xhs_profile",
]);

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

export type CliLocalRuntimeDb = CliKvDb;

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
};

async function defaultLocalRuntimeDb(): Promise<CliLocalRuntimeDb> {
  ensureHeavyCliLocalRuntimeModules();
  return getDefaultCliLocalRuntimeDb();
}

function createFallbackId() {
  ensureHeavyCliLocalRuntimeModules();
  return ulid();
}

function resolveLocalUserId(env: EnvLike) {
  const explicitUserId = env.NOLO_LOCAL_USER_ID || env.NOLO_USER_ID;
  if (explicitUserId) return explicitUserId;
  const tokenUserId = parseUserIdFromAuthToken(resolveRuntimeAuthToken(env));
  return tokenUserId || "local";
}

function resolveBuiltinLocalCliAgentConfig(
  agentRef: string,
  userId: string,
): AgentRuntimeAgentConfig | null {
  const normalized = agentRef.trim();
  if (
    normalized === LOCAL_CODEX_AGENT_KEY ||
    normalized === LOCAL_CODEX_AGENT_ID
  ) {
    return {
      key: LOCAL_CODEX_AGENT_KEY,
      name: "Local Codex",
      prompt:
        "You are a local Codex CLI coding agent. Use the workspace and dialog evidence available to you, keep changes scoped, run relevant checks, and report worktree, branch, commit or dirty diff, tests, and blockers.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "codex",
      toolNames: ["readFile", "searchFiles", "execShell", "fetchWebpage", "exa_search"],
      rawRecord: {
        dbKey: LOCAL_CODEX_AGENT_KEY,
        id: LOCAL_CODEX_AGENT_ID,
        userId,
        type: "agent",
        name: "Local Codex",
        apiSource: "cli",
        provider: "cli",
        cliProvider: "codex",
      },
    };
  }
  return null;
}

function parseLocalToolBudgets(env: EnvLike) {
  const raw = env.NOLO_LOCAL_TOOL_BUDGETS?.trim();
  if (!raw) return {};
  const budgets: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const [name, value] = part.split("=").map((item) => item.trim());
    const limit = Number(value);
    if (name && Number.isFinite(limit) && limit >= 0)
      budgets[name] = Math.floor(limit);
  }
  return budgets;
}

function assertWithinLocalToolBudget(args: {
  toolName: string;
  budgets: Record<string, number>;
  usage: Map<string, number>;
}) {
  const limit = args.budgets[args.toolName];
  if (typeof limit !== "number") return;
  const nextCount = (args.usage.get(args.toolName) ?? 0) + 1;
  args.usage.set(args.toolName, nextCount);
  if (nextCount <= limit) return;
  throw new Error(
    `${args.toolName} exceeded local tool budget ${limit}. Stop broad discovery; edit the narrowest likely file or report a blocker.`,
  );
}

function isTransientFetchError(error: unknown) {
  const message = toErrorMessage(error);
  return /certificate|handshake|network|socket|timed out|timeout|ECONNRESET/i.test(
    message,
  );
}

async function defaultSleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function transientFetchRetryDelayMs(attempt: number) {
  return Math.min(attempt * TRANSIENT_FETCH_RETRY_BASE_DELAY_MS, 2_000);
}

/**
 * 上游明确表示「我没受理」的状态码，与服务端 chatUpstreamRetry 的 GENTLE_RETRY_STATUSES
 * 保持同一口径：重试不会产生重复 token、不会重复计费。
 * 502/504 不在内——那两个可能意味着请求已被处理，重试有副作用风险。
 */
const RETRYABLE_HTTP_STATUSES = new Set([429, 503]);

/**
 * 从一个可重试响应里读出建议等待时长。
 *
 * nolo 服务端在排空/限流时会明确给出信号，例如
 *   503 {"error":"Server draining","reason":"core_draining","retryable":true,"retryAfterMs":1500}
 * 以前客户端完全不看这些字段——`fetchWithTransientRetry` 只在**抛异常**时重试，
 * 而 503 是一次成功的 HTTP 交换，于是服务端说「可以重试、等我 1.5 秒」，
 * 客户端却直接把它当成终局失败上报给用户。
 *
 * 优先级：标准 `Retry-After` 头 > 响应体 `retryAfterMs` > 既有退避。
 * 读体前先 clone，避免把调用方要用的 body 消费掉。
 */
async function resolveRetryAfterMs(
  response: Response,
  attempt: number,
): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
  }
  try {
    const body = await response.clone().text();
    const parsed = JSON.parse(body) as { retryAfterMs?: unknown };
    const ms = Number(parsed?.retryAfterMs);
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 10_000);
  } catch {
    // 非 JSON 或 body 不可读：退回既有退避。
  }
  return transientFetchRetryDelayMs(attempt);
}

function isLoopbackUrl(input: FetchInput) {
  try {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const hostname = target.hostname.toLowerCase();
    return (
      hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function toNodeRequestBody(body: FetchInit["body"]) {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return null;
}

async function defaultLoopbackRequest(input: FetchInput, init?: FetchInit) {
  const target =
    typeof input === "string" || input instanceof URL
      ? new URL(String(input))
      : new URL(input.url);
  const headers = new Headers(init?.headers);
  const body = toNodeRequestBody(init?.body);
  if (body && !headers.has("Content-Length")) {
    headers.set("Content-Length", String(body.byteLength));
  }
  return await new Promise<Response>((resolve, reject) => {
    const requestImpl =
      target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      target,
      {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: res.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    init?.signal?.addEventListener(
      "abort",
      () => {
        req.destroy(
          init.signal?.reason instanceof Error
            ? init.signal.reason
            : new Error("request aborted"),
        );
        reject(init.signal?.reason ?? new Error("request aborted"));
      },
      { once: true },
    );
    if (body) req.write(body);
    req.end();
  });
}

export async function fetchWithTransientRetry(
  fetchImpl: CliFetchImpl,
  input: FetchInput,
  init?: FetchInit,
  options: {
    sleep?: (ms: number) => Promise<void>;
    loopbackRequest?: (
      input: FetchInput,
      init?: FetchInit,
    ) => Promise<Response>;
  } = {},
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (options.loopbackRequest && isLoopbackUrl(input)) {
        return await options.loopbackRequest(input, init);
      }
      const response = await fetchImpl(input, init);
      // 429/503 是一次**成功的** HTTP 交换，不会走到下面的 catch。以前这里直接
      // 把它返回给调用方，于是服务端 `retryable: true, retryAfterMs: 1500` 这类
      // 明示信号被完全无视，一次容量抖动就成了用户可见的终局失败。
      if (
        RETRYABLE_HTTP_STATUSES.has(response.status) &&
        attempt < TRANSIENT_FETCH_MAX_ATTEMPTS &&
        !init?.signal?.aborted
      ) {
        const delayMs = await resolveRetryAfterMs(response, attempt);
        await (options.sleep ?? defaultSleep)(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      if (!isTransientFetchError(error)) throw error;
      lastError = error;
      if (attempt < TRANSIENT_FETCH_MAX_ATTEMPTS) {
        await (options.sleep ?? defaultSleep)(
          transientFetchRetryDelayMs(attempt),
        );
      }
    }
  }
  throw lastError;
}

function parseJsonObject(raw: string) {
  try {
    return asRecordOrEmpty(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

function isCliProviderAgent(agentConfig: AgentRuntimeAgentConfig) {
  return Boolean(
    agentConfig.apiSource === "cli" ||
    agentConfig.provider === "cli" ||
    agentConfig.cliProvider,
  );
}

function resolveCliProviderName(agentConfig: AgentRuntimeAgentConfig) {
  return (
    (agentConfig.cliProvider || agentConfig.provider || "codex").trim() ||
    "codex"
  );
}

function stringifyRuntimeMessageContent(
  content: AgentRuntimeChatMessage["content"],
) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      let text: string;
      if (typeof part === "string") {
        text = part;
      } else if (part && typeof part === "object" && "text" in part) {
        text = String(part.text ?? "");
      } else {
        text = JSON.stringify(part);
      }
      if (text.trim()) parts.push(text);
    }
    return parts.join("\n");
  }
  return content == null ? "" : String(content);
}

function buildPromptForCliProvider(messages: AgentRuntimeChatMessage[]) {
  const systemParts: string[] = [];
  const taskParts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const content = stringifyRuntimeMessageContent(message.content).trim();
      if (content) systemParts.push(content);
    } else {
      const content = stringifyRuntimeMessageContent(message.content).trim();
      if (content) {
        taskParts.push(`[${message.role}]\n${content}`);
      }
    }
  }
  const systemPrompt = systemParts.join("\n\n");
  const taskPrompt = taskParts.join("\n\n");
  return buildCliPrompt(systemPrompt, taskPrompt);
}

function collectCliProviderImageInputs(messages: AgentRuntimeChatMessage[]) {
  const urls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part &&
        typeof part === "object" &&
        (part as any).type === "image_url" &&
        typeof (part as any).image_url?.url === "string" &&
        (part as any).image_url.url.trim()
      ) {
        urls.push((part as any).image_url.url.trim());
      }
    }
  }
  return urls;
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

function buildOpenAiTools(args: {
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
  return [
    ...callAgentTools,
    ...uiAskChoiceTools,
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
 * CLI 端默认开 code 能力包：enabledPacks 为空时补 ["code"]，保持
 * 「CLI agent 默认能改代码」的体感，但走显式能力包而非隐式兜底
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
    return ["code"];
  }
  return base;
}

/**
 * CLI 端 requestedToolNames 管道：expandEnabledPacks → canonicalize →
 * addDefaultCliCoreTools → addDefaultLightWebToolsForConfiguredAgents → applyDisabledTools。
 * resolveProviderOpenAiToolBundle 和 loadAgentConfig 两条路径共用，避免重复。
 */
function resolveCliRequestedToolNames(
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
) {
  const requestedToolNames = resolveCliRequestedToolNames(agentConfig, env);
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

function buildLocalPolicyToolNames(args: {
  toolNames?: string[];
  env: EnvLike;
}) {
  return [
    ...buildLocalWorkspacePolicyToolNames({
      declaredToolNames: args.toolNames,
      exposeShellTools: true,
      useDeclaredToolNamesOnly: shouldUseDeclaredOnlyLocalWorkspaceTools(
        args.env,
      ),
    }),
    ...(() => {
      const extra: string[] = [];
      const names = args.toolNames ?? [];
      for (const name of names) {
        if (REGISTRY_INJECTED_TOOL_NAMES.has(name)) extra.push(name);
        if (LOCAL_SERVER_TABLE_TOOL_NAME_SET.has(name)) extra.push(name);
        if (LOCAL_SERVER_WEB_TOOL_NAME_SET.has(name)) extra.push(name);
      }
      return extra;
    })(),
    ...filterNoloWorkspaceToolNames(args.toolNames),
  ];
}

function shouldUseDeclaredOnlyLocalWorkspaceTools(env: EnvLike) {
  const value =
    env.NOLO_LOCAL_WORKSPACE_TOOLSET || env.NOLO_LOCAL_TOOLSET_MODE || "";
  return value === "declared-only" || value === "declared";
}

function resolveGlobFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_GLOBFILES_DESCRIPTION_VARIANT,
  );
}

function resolveListFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_LISTFILES_DESCRIPTION_VARIANT,
  );
}

function resolveListFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_LISTFILES_PARAMETER_VARIANT,
  );
}

function resolveReadFileDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_READFILE_DESCRIPTION_VARIANT,
  );
}

function resolveReadFileParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_READFILE_PARAMETER_VARIANT,
  );
}

function resolveGlobFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_GLOBFILES_PARAMETER_VARIANT,
  );
}

function resolveSearchFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_SEARCHFILES_DESCRIPTION_VARIANT,
  );
}

function resolveSearchFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_SEARCHFILES_PARAMETER_VARIANT,
  );
}

function resolveLocalWorkspaceDescriptionVariant(value: string | undefined) {
  return value === "brief" ||
    value === "strategy" ||
    value === "workflow" ||
    value === "antiShell"
    ? value
    : "strategy";
}

function resolveLocalWorkspaceParameterVariant(value: string | undefined) {
  return value === "minimal" || value === "scoped" || value === "rich"
    ? value
    : "rich";
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

function buildCliWorkspaceToolExecutors(args: {
  env: EnvLike;
  cliEntrypoint?: string;
}) {
  return buildNoloWorkspaceCliToolExecutors({
    cliEntrypoint: args.cliEntrypoint ?? CLI_ENTRYPOINT,
    env: args.env,
    metadataKind: "cliWorkspaceTool",
  });
}

export function isBuiltinNoloAgentRef(ref: unknown) {
  if (typeof ref !== "string") return false;
  const normalized = ref.trim();
  return (
    normalized === BUILTIN_NOLO_AGENT_KEY ||
    normalized === BUILTIN_NOLO_AGENT_ID ||
    normalized.endsWith(`-${BUILTIN_NOLO_AGENT_ID}`)
  );
}

function isBuiltinNoloAgentConfig(
  agentConfig: AgentRuntimeAgentConfig | null | undefined,
) {
  const key =
    agentConfig?.key ||
    agentConfig?.rawRecord?.dbKey ||
    agentConfig?.rawRecord?.agentKey;
  const id = agentConfig?.rawRecord?.id;
  return isBuiltinNoloAgentRef(key) || isBuiltinNoloAgentRef(id);
}

function withResolvedRuntimeToolSurface(
  agentConfig: AgentRuntimeAgentConfig | null,
  env: EnvLike,
) {
  if (!agentConfig) return agentConfig;
  const currentUserId = resolveLocalUserId(env);
  const rawRecord = (agentConfig as any).rawRecord ?? {};
  const ownerId = asOptionalTrimmedString(rawRecord.userId) ?? null;
  const toolSurface = resolveRuntimeToolSurfaceForAgent({
    explicitToolNames: agentConfig.toolNames,
    currentUserId,
    agentOwnerId: ownerId,
    agentKey: rawRecord.dbKey ?? agentConfig.key,
    isPublic:
      !isBuiltinNoloAgentConfig(agentConfig) && rawRecord.isPublic === true,
    sharingLevel:
      typeof rawRecord.sharingLevel === "string"
        ? rawRecord.sharingLevel
        : null,
    trustedPrivateInvocation: isBuiltinNoloAgentConfig(agentConfig),
    runtimeHost: "cli",
  });
  return {
    ...agentConfig,
    toolNames: toolSurface.finalToolNames,
    toolSurface,
    prompt: agentConfig.prompt,
  };
}

function extractLastUserText(messages: AgentRuntimeChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text ?? "")
      .join(" ");
  }
  return "";
}

function localTurnHasSubjectRefs(input: AgentRuntimeSaveTurnInput) {
  return (
    Array.isArray(input.runtimeContext?.subjectRefs) &&
    input.runtimeContext.subjectRefs.length > 0
  );
}

function buildServerPlatformToolExecutors(args: {
  env: EnvLike;
  fetchImpl: CliFetchImpl;
}) {
  const postServer = async (path: string, body: object) => {
    const serverUrl = resolveRuntimeServerUrl(args.env);
    const authToken = resolveRuntimeAuthToken(args.env);
    if (!serverUrl)
      throw new Error(
        "server platform tools require NOLO_SERVER_URL, NOLO_SERVER, or BASE_URL.",
      );
    if (!authToken)
      throw new Error(
        "server platform tools require AUTH_TOKEN or NOLO_MACHINE_API_KEY.",
      );
    const response = await args.fetchImpl(`${serverUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `server platform tool bridge failed: HTTP ${response.status} ${text.slice(0, 500)}`,
      );
    }
    return text;
  };
  const guardExplicitTableCapture = (call: any) => {
    if (inferCaptureIntent(String(call.userInput ?? "")) === "strong")
      return null;
    return JSON.stringify({
      error: "knowledge_capture_requires_confirmation",
      message:
        "当前本地运行不允许自动写入表格。只有当用户在当前请求里明确要求保存、建表、写入 table 或做成数据集时，才能继续；否则请先询问用户。",
      policy: {
        capability: "knowledge_capture",
        target: "table",
        mode: "explicit-only-local",
      },
    });
  };
  const tableExecutors = Object.fromEntries(
    LOCAL_SERVER_TABLE_TOOL_NAMES.map((toolName) => [
      toolName,
      async (call: any) => {
        const blocked = guardExplicitTableCapture(call);
        if (blocked) {
          return {
            content: blocked,
            metadata: { serverPlatformTool: true, tableWriteBlocked: true },
          };
        }
        const parsed = parseNoloWorkspaceToolArguments(call.arguments);
        const path =
          toolName === "createTable"
            ? "/api/table/create"
            : toolName === "addTableRow"
              ? "/api/table/add-row"
              : toolName === "addTableRows"
                ? "/api/table/add-rows"
                : toolName === "updateTableRow"
                  ? "/api/table/update-row"
                  : "/api/table/update-rows";
        const content = await postServer(path, parsed);
        return {
          content,
          metadata: { serverPlatformTool: true, tableWrite: true },
        };
      },
    ]),
  );
  // Web access tools (fetchWebpage / exa_search) bridge to the same server
  // routes the desktop runtime uses. The CLI holds no local API keys, so these
  // only work when NOLO_SERVER_URL + auth are configured.
  const webExecutors = Object.fromEntries(
    LOCAL_SERVER_WEB_TOOL_NAMES.map((toolName) => [
      toolName,
      async (call: any) => {
        const parsed = parseNoloWorkspaceToolArguments(call.arguments);
        const path =
          toolName === "fetchWebpage"
            ? "/api/fetch-webpage"
            : "/api/exa-search";
        const body =
          toolName === "fetchWebpage"
            ? { url: parsed.url }
            : {
                query: parsed.query,
                numResults: parsed.numResults ?? 5,
                useAutoprompt: parsed.useAutoprompt ?? true,
                type: parsed.type ?? "neural",
                // Model schema uses `includeContent` (boolean); the Exa API
                // expects `contents: { text: true }`. Mirror exaSearchFunc's
                // conversion so CLI proxy results match web behavior.
                contents:
                  parsed.includeContent !== false ? { text: true } : undefined,
              };
        const content = await postServer(path, body);
        return {
          content,
          metadata: { serverPlatformTool: true, webTool: toolName },
        };
      },
    ]),
  );
  return { ...tableExecutors, ...webExecutors };
}

function buildCliDelegatedAgentInput(task: string, input?: any): string {
  if (input === undefined || input === null) {
    return task;
  }
  if (typeof input === "string") {
    return `${task}\n\n--- INPUT (text) ---\n${input}`;
  }
  return `${task}\n\n--- INPUT (json) ---\n${JSON.stringify(input, null, 2)}`;
}

async function persistCliPendingChildDialog(args: {
  store: HybridRecordStore;
  userId: string;
  dialogId: string;
  agentKey: string;
  title: string;
  spaceId?: string;
  parentDialogId?: string;
  rootDialogId?: string;
  workspaceRoot: string;
  background: boolean;
  now: number;
}) {
  const nowIso = new Date(args.now).toISOString();
  const dialogKey = `dialog-${args.userId}-${args.dialogId}`;
  const record: Record<string, unknown> = {
    id: args.dialogId,
    dbKey: dialogKey,
    type: "dialog",
    userId: args.userId,
    cybots: [args.agentKey],
    primaryAgentKey: args.agentKey,
    title: args.title.slice(0, 80),
    status: "pending",
    triggerType: "cli-local",
    executionMode: args.background ? "background" : "foreground",
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(args.spaceId ? { spaceId: args.spaceId } : {}),
    ...(args.parentDialogId ? { parentDialogId: args.parentDialogId } : {}),
    ...(args.rootDialogId ? { rootDialogId: args.rootDialogId } : {}),
    localRuntime: {
      host: "cli",
      workspaceRoot: args.workspaceRoot,
      workspaceKind: "current",
      workspaceAccess: "inherited",
    },
  };
  await args.store.batch([{ type: "put", key: dialogKey, value: record }]);
}

async function persistCliFailedChildDialog(args: {
  store: HybridRecordStore;
  userId: string;
  dialogId: string;
  errorMessage: string;
  now: number;
}) {
  const dialogKey = `dialog-${args.userId}-${args.dialogId}`;
  const existing = await args.store.read(dialogKey);
  const existingRecord =
    existing && typeof existing === "object"
      ? (existing as Record<string, unknown>)
      : {};
  await args.store.batch([
    {
      type: "put",
      key: dialogKey,
      value: {
        ...existingRecord,
        id: args.dialogId,
        dbKey: dialogKey,
        status: "failed",
        errorMessage: args.errorMessage,
        updatedAt: new Date(args.now).toISOString(),
        finishedAt: args.now,
      },
    },
  ]);
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
  ensureHeavyCliLocalRuntimeModules();
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
      input: buildCliDelegatedAgentInput(task, parsed.input),
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

function buildLocalToolExecutors(args: {
  workspaceRoot: string;
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  localToolExecutors?: CliLocalRuntimeAdapterDeps["localToolExecutors"];
  readXPost?: CliLocalRuntimeAdapterDeps["readXPost"];
  readXhsProfile?: CliLocalRuntimeAdapterDeps["readXhsProfile"];
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  /** Reused for external-file-access prompts (same PermissionRequest shape). */
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /** Interactive choice dialog for ui_ask_choice; absent in headless/CI mode. */
  requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
}) {
  return {
    ...createLocalWorkspaceToolExecutors({
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      commandOutputLimit: args.commandOutputLimit,
      ...(args.confirmDestructiveAction
        ? { confirmExternalFileAccess: args.confirmDestructiveAction }
        : {}),
    }),
    ...buildServerPlatformToolExecutors({
      env: args.env,
      fetchImpl: args.fetchImpl,
    }),
    ...buildCliWorkspaceToolExecutors({
      env: args.env,
    }),
    read_x_post: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const result = await (args.readXPost ?? readXPostFunc)(
        parsedArgs,
        undefined,
      );
      return {
        content: JSON.stringify(result.rawData),
        metadata: {
          xPostLocalBridge: true,
          displayData: result.displayData,
        },
      };
    },
    read_xhs_profile: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const result = await (args.readXhsProfile ?? readXhsProfileFunc)(
        parsedArgs,
        undefined,
      );
      return {
        content: JSON.stringify(result.rawData),
        metadata: {
          xhsLocalBridge: true,
          displayData: result.displayData,
        },
      };
    },
    ui_ask_choice: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const question = String(parsedArgs.question ?? "").trim();
      const choices = Array.isArray(parsedArgs.choices) ? parsedArgs.choices : [];
      const blocking = parsedArgs.blocking !== false;
      if (!question || choices.length === 0) {
        return {
          content: JSON.stringify({
            error: "ui_ask_choice",
            detail: "ui_ask_choice 需要 question 和至少一个 choice。",
          }),
          metadata: { uiAskChoice: true, error: true },
        };
      }
      // Interactive TUI: show an arrow-key select dialog docked above the
      // composer and resolve the user's pick into the next userMessage.
      // Headless / non-TTY / no-callback: fall back to the raw JSON payload so
      // the toolOutput renderer can print a numbered text menu.
      if (args.requestUserChoice) {
        try {
          const result = await args.requestUserChoice({
            question,
            choices,
            blocking,
          });
          if (result.kind === "selected") {
            return {
              content: JSON.stringify({
                type: "ui_ask_choice",
                question,
                choices,
                blocking,
                selected: {
                  label: result.label,
                  userMessage: result.userMessage,
                },
              }),
              metadata: { uiAskChoice: true, resolved: true },
            };
          }
          // Cancelled: tell the model the user declined to choose, so it can
          // either ask differently or proceed with its own best judgement.
          return {
            content: JSON.stringify({
              type: "ui_ask_choice",
              question,
              choices,
              blocking,
              selected: { label: "", userMessage: "" },
              cancelled: true,
            }),
            metadata: { uiAskChoice: true, resolved: true, cancelled: true },
          };
        } catch {
          // Dialog failed (e.g. non-TTY despite a callback being wired);
          // fall through to the non-interactive payload below.
        }
      }
      return {
        content: JSON.stringify({
          type: "ui_ask_choice",
          question,
          choices,
          blocking,
        }),
        metadata: { uiAskChoice: true },
      };
    },
    ...(args.localToolExecutors ?? {}),
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

async function readAgentFromStore(args: {
  store: HybridRecordStore;
  agentRef: string;
  userId: string;
}): Promise<AgentRuntimeAgentConfig | null> {
  // Sequential lookup with early return — each key must be checked in order, stopping at first match.
  for (const key of buildLocalAgentLookupKeys(args)) {
    const record = await args.store.read(key, {
      remote: shouldReadAgentKeyRemotely(key),
    });
    if (!record || typeof record !== "object") continue;
    return resolveAgentRuntimeConfigFromRecord(key, record);
  }
  const normalizedRef = normalizeAgentHandle(args.agentRef);
  if (!normalizedRef) return null;
  try {
    // Async iterator — must consume entries sequentially from the store cursor.
    const iterator = args.store.iterator({
      gte: "agent-",
      lte: "agent-\uffff",
    });
    for await (const [key, record] of iterator) {
      if (!record || typeof record !== "object") continue;
      const handle = normalizeAgentHandle((record as any).handle);
      if (handle !== normalizedRef) continue;
      return resolveAgentRuntimeConfigFromRecord(key, record);
    }
  } catch {
    // local handle scan unavailable
  }
  return null;
}

async function readDialogMessages(args: {
  store: HybridRecordStore;
  dialogId: string;
}) {
  const messages: AgentRuntimeChatMessage[] = [];
  const { start, end } = dialogMessageRange(args.dialogId);
  const iterator = args.store.iterator({ gte: start, lte: end });
  // Async iterator — must consume entries sequentially from the store cursor.
  for await (const [, value] of iterator) {
    const message = localDialogMessageRecordToRuntimeMessage(value);
    if (message) messages.push(message);
  }
  return messages;
}

/**
 * Build a title generator closure for CLI-local dialog title generation.
 * Uses the Nolo platform chat proxy (same route as agent inference) with
 * the builtin title LLM config (deepseek-v4-flash).
 *
 * Returns null when platform chat provider is unavailable (no AUTH_TOKEN).
 */
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
  // Defer until first call — modules are loaded by ensureHeavyCliLocalRuntimeModules().
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

export function createCliLocalRuntimeAdapter(
  deps: CliLocalRuntimeAdapterDeps,
): AgentRuntimeHostAdapter {
  // Defer heavy graph until a local runtime adapter is actually constructed
  // (not when this module is imported for cache-clear / builtin helpers).
  ensureHeavyCliLocalRuntimeModules();
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
  let activeAgentToolNames: string[] = [];
  const workspaceRoot = deps.cwd ?? process.cwd();
  let runtimeToolExecutionLimits: ReturnType<
    typeof resolveLocalWorkspaceExecutorOptionsFromPolicy
  > = {};
  let localToolExecutors = buildLocalToolExecutors({
    workspaceRoot,
    env: deps.env,
    fetchImpl,
    localToolExecutors: deps.localToolExecutors,
    readXPost: deps.readXPost,
    readXhsProfile: deps.readXhsProfile,
    ...(deps.confirmDestructiveAction
      ? { confirmDestructiveAction: deps.confirmDestructiveAction }
      : {}),
    ...(deps.requestUserChoice
      ? { requestUserChoice: deps.requestUserChoice }
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
      const cached = preparedAgentRuntimeCache.get(cacheKey);
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
      const agentConfig = withResolvedRuntimeToolSurface(
        storedAgentConfig ?? fallbackLocalCliAgentConfig,
        deps.env,
      );
      const requestedToolNames = agentConfig
        ? resolveCliRequestedToolNames(agentConfig, deps.env)
        : [];
      activeAgentToolNames = buildLocalPolicyToolNames({
        toolNames: requestedToolNames,
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
        ...(deps.confirmDestructiveAction
          ? { confirmDestructiveAction: deps.confirmDestructiveAction }
          : {}),
        ...(deps.requestUserChoice
          ? { requestUserChoice: deps.requestUserChoice }
          : {}),
        ...runtimeToolExecutionLimits,
      });
      if (agentConfig) {
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
            const res = await fetchWithTransientRetry(
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
            if (!res.ok) {
              const raw = await res.text().catch(() => "");
              const data = parsePlatformChatCompletionData(raw);
              throw new Error(
                `platform provider failed: HTTP ${res.status} ${JSON.stringify(data)}`,
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
    executeTool: async (call) => {
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

