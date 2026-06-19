import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeHostAdapter,
  AgentRuntimeSaveTurnInput,
} from "../agentRuntimeLocal";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLocalWorkspacePolicyToolNames,
  buildLocalWorkspaceToolset,
  buildLocalWorkspaceOpenAiTools,
  buildOpenAiCompatibleChatCompletionRequest,
  executeOpenAiCompatibleChatCompletion,
  readOpenAiCompatibleSseCompletion,
  buildPlatformChatCompletionRequest,
  createLocalWorkspaceToolExecutors,
  parseOpenAiCompatibleChatCompletionResponse,
  parsePlatformChatCompletionData,
  parsePlatformChatCompletionResponse,
  resolvePlatformChatProviderConfig,
  resolveCurrentRunRuntimeToolPolicy,
  resolveLocalWorkspaceExecutorOptionsFromPolicy,
  resolveRequestedRuntimeToolNames,
  resolveRuntimeToolSurfaceForAgent,
  shouldUsePlatformChatProvider,
} from "../agentRuntimeLocal";
import type { AgentRuntimeChatMessage } from "../../agent-runtime";
import { getDefaultCliLocalRuntimeDb } from "../localRuntimeDb";
import { resolveAgentRuntimeConfigFromRecord } from "./agentConfigResolver";
import { resolveCliOpenAiProviderConfig } from "./localProviderResolver";
import {
  buildLocalDialogWritePlan,
  localDialogMessageRecordToRuntimeMessage,
} from "./localDialogRecords";
import {
  buildLocalAgentLookupKeys,
  shouldReadAgentKeyRemotely,
} from "./localAgentRecords";
import {
  createCliHybridRecordStore,
  type CliKvDb,
  type HybridRecordStore,
} from "./hybridRecordStore";
import { executeLocalToolWithPolicy } from "./localToolPolicy";
import { inferCaptureIntent } from "../../ai/policy/runtimePolicy";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import { TOOL_PACKS } from "../../ai/tools/toolPacks";
import { prepareTools } from "../../ai/tools/prepareTools";
import {
  LOCAL_CODEX_AGENT_ID,
  LOCAL_CODEX_AGENT_KEY,
  LOCAL_GROK_AGENT_ID,
  LOCAL_GROK_AGENT_KEY,
  LOCAL_OPENCODE_AGENT_ID,
  LOCAL_OPENCODE_AGENT_KEY,
  LOCAL_QODER_AGENT_ID,
  LOCAL_QODER_AGENT_KEY,
  MIMO_MONTH_AGENT_KEY,
  NOLO_DEFAULT_AGENT_ID,
  NOLO_DEFAULT_AGENT_KEY,
} from "../agentAliases";
import {
  buildNoloWorkspaceCliToolExecutors,
  buildNoloWorkspaceOpenAiTools,
  filterNoloWorkspaceToolNames,
  parseNoloWorkspaceToolArguments,
} from "../../agent-runtime/noloWorkspaceTools";
import {
  executeCli as defaultExecuteCli,
  type CliExecuteResult,
  type CliImageInput,
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

type EnvLike = Record<string, string | undefined>;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
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
  }
) => Promise<CliExecuteResult>;
const TRANSIENT_FETCH_MAX_ATTEMPTS = 8;
const TRANSIENT_FETCH_RETRY_BASE_DELAY_MS = 250;
export const BUILTIN_NOLO_AGENT_ID = NOLO_DEFAULT_AGENT_ID;
export const BUILTIN_NOLO_AGENT_KEY = NOLO_DEFAULT_AGENT_KEY;
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRYPOINT = join(CLI_DIR, "..", "index.ts");
const LOCAL_SERVER_TABLE_TOOL_NAMES = [
  "createTable",
  "addTableRow",
  "addTableRows",
  "updateTableRow",
  "updateTableRows",
] as const;
const LOCAL_SERVER_TABLE_TOOL_NAME_SET = new Set<string>(LOCAL_SERVER_TABLE_TOOL_NAMES);

export type CliLocalRuntimeDb = CliKvDb;

export type CliLocalRuntimeAdapterDeps = {
  env: EnvLike;
  db?: CliLocalRuntimeDb;
  store?: HybridRecordStore;
  now?: () => number;
  createId?: () => string;
  fetchImpl?: typeof fetch;
  cwd?: string;
  output?: { write(chunk: string): unknown };
  localToolExecutors?: Record<string, (call: any) => Promise<{ content: string; metadata?: Record<string, unknown> }>>;
  readXPost?: typeof readXPostFunc;
  readXhsProfile?: typeof readXhsProfileFunc;
  executeCli?: LocalCliExecutor;
  sleep?: (ms: number) => Promise<void>;
  loopbackRequest?: (input: FetchInput, init?: FetchInit) => Promise<Response>;
};

async function defaultLocalRuntimeDb(): Promise<CliLocalRuntimeDb> {
  return getDefaultCliLocalRuntimeDb();
}

function createFallbackId() {
  return ulid();
}

function resolveLocalUserId(env: EnvLike) {
  const explicitUserId = env.NOLO_LOCAL_USER_ID || env.NOLO_USER_ID;
  if (explicitUserId) return explicitUserId;
  const tokenUserId = parseUserIdFromAuthToken(resolveRuntimeAuthToken(env));
  return tokenUserId || "local";
}

function resolveBuiltinLocalCliAgentConfig(agentRef: string, userId: string): AgentRuntimeAgentConfig | null {
  const normalized = agentRef.trim();
  if (normalized === LOCAL_CODEX_AGENT_KEY || normalized === LOCAL_CODEX_AGENT_ID) {
    return {
      key: LOCAL_CODEX_AGENT_KEY,
      name: "Local Codex",
      prompt: "You are a local Codex CLI coding agent. Use the workspace and dialog evidence available to you, keep changes scoped, run relevant checks, and report worktree, branch, commit or dirty diff, tests, and blockers.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "codex",
      toolNames: ["readFile", "searchFiles", "execShell"],
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
  if (normalized === LOCAL_QODER_AGENT_KEY || normalized === LOCAL_QODER_AGENT_ID) {
    return {
      key: LOCAL_QODER_AGENT_KEY,
      name: "Local Qoder",
      prompt: "You are a local Qoder CLI coding agent. Use the workspace and dialog evidence available to you, keep changes scoped, run relevant checks, and report worktree, branch, commit or dirty diff, tests, and blockers.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "qoder",
      model: "Qwen3.7-Max",
      toolNames: ["readFile", "searchFiles", "execShell"],
      rawRecord: {
        dbKey: LOCAL_QODER_AGENT_KEY,
        id: LOCAL_QODER_AGENT_ID,
        userId,
        type: "agent",
        name: "Local Qoder",
        apiSource: "cli",
        provider: "cli",
        cliProvider: "qoder",
        model: "Qwen3.7-Max",
      },
    };
  }
  if (normalized === LOCAL_OPENCODE_AGENT_KEY || normalized === LOCAL_OPENCODE_AGENT_ID) {
    return {
      key: LOCAL_OPENCODE_AGENT_KEY,
      name: "Local OpenCode",
      prompt: "You are a local OpenCode CLI coding agent. Use the workspace and dialog evidence available to you, keep changes scoped, run relevant checks, and report worktree, branch, commit or dirty diff, tests, and blockers.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "opencode",
      toolNames: ["readFile", "searchFiles", "execShell"],
      rawRecord: {
        dbKey: LOCAL_OPENCODE_AGENT_KEY,
        id: LOCAL_OPENCODE_AGENT_ID,
        userId,
        type: "agent",
        name: "Local OpenCode",
        apiSource: "cli",
        provider: "cli",
        cliProvider: "opencode",
      },
    };
  }
  if (normalized === LOCAL_GROK_AGENT_KEY || normalized === LOCAL_GROK_AGENT_ID) {
    return {
      key: LOCAL_GROK_AGENT_KEY,
      name: "Local Grok",
      prompt: "You are a local Grok CLI coding agent. Use the workspace and dialog evidence available to you, keep changes scoped, run relevant checks, and report worktree, branch, commit or dirty diff, tests, and blockers.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "grok",
      toolNames: ["readFile", "searchFiles", "execShell"],
      rawRecord: {
        dbKey: LOCAL_GROK_AGENT_KEY,
        id: LOCAL_GROK_AGENT_ID,
        userId,
        type: "agent",
        name: "Local Grok",
        apiSource: "cli",
        provider: "cli",
        cliProvider: "grok",
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
    if (name && Number.isFinite(limit) && limit >= 0) budgets[name] = Math.floor(limit);
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
    `${args.toolName} exceeded local tool budget ${limit}. Stop broad discovery; edit the narrowest likely file or report a blocker.`
  );
}

function isTransientFetchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /certificate|handshake|network|socket|timed out|timeout|ECONNRESET/i.test(message);
}

async function defaultSleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function transientFetchRetryDelayMs(attempt: number) {
  return Math.min(attempt * TRANSIENT_FETCH_RETRY_BASE_DELAY_MS, 2_000);
}

function isLoopbackUrl(input: FetchInput) {
  try {
    const target = typeof input === "string" || input instanceof URL
      ? new URL(String(input))
      : new URL(input.url);
    const hostname = target.hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
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
  const target = typeof input === "string" || input instanceof URL
    ? new URL(String(input))
    : new URL(input.url);
  const headers = new Headers(init?.headers);
  const body = toNodeRequestBody(init?.body);
  if (body && !headers.has("Content-Length")) {
    headers.set("Content-Length", String(body.byteLength));
  }
  return await new Promise<Response>((resolve, reject) => {
    const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(target, {
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 500,
          headers: res.headers as Record<string, string>,
        }));
      });
    });
    req.on("error", reject);
    init?.signal?.addEventListener("abort", () => {
      req.destroy(
        init.signal?.reason instanceof Error ? init.signal.reason : new Error("request aborted")
      );
      reject(init.signal?.reason ?? new Error("request aborted"));
    }, { once: true });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchWithTransientRetry(
  fetchImpl: typeof fetch,
  input: FetchInput,
  init?: FetchInit,
  options: {
    sleep?: (ms: number) => Promise<void>;
    loopbackRequest?: (input: FetchInput, init?: FetchInit) => Promise<Response>;
  } = {}
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (options.loopbackRequest && isLoopbackUrl(input)) {
        return await options.loopbackRequest(input, init);
      }
      return await fetchImpl(input, init);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      if (!isTransientFetchError(error)) throw error;
      lastError = error;
      if (attempt < TRANSIENT_FETCH_MAX_ATTEMPTS) {
        await (options.sleep ?? defaultSleep)(transientFetchRetryDelayMs(attempt));
      }
    }
  }
  throw lastError;
}

function buildRequestTimeoutSignal(timeoutMs?: number) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function summarizeEndpoint(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function parseJsonObject(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isCliProviderAgent(agentConfig: AgentRuntimeAgentConfig) {
  return Boolean(
    agentConfig.apiSource === "cli" ||
      agentConfig.provider === "cli" ||
      agentConfig.cliProvider
  );
}

function resolveCliProviderName(agentConfig: AgentRuntimeAgentConfig) {
  return (agentConfig.cliProvider || agentConfig.provider || "codex").trim() || "codex";
}

function stringifyRuntimeMessageContent(content: AgentRuntimeChatMessage["content"]) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as any).text ?? "");
        }
        return JSON.stringify(part);
      })
      .filter((part) => part.trim())
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function buildPromptForCliProvider(messages: AgentRuntimeChatMessage[]) {
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => stringifyRuntimeMessageContent(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const taskPrompt = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = stringifyRuntimeMessageContent(message.content).trim();
      if (!content) return "";
      return `[${message.role}]\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
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

function logLocalRuntimeDiagnostic(event: string, fields: Record<string, unknown>) {
  if (
    process.env.NOLO_LOCAL_RUNTIME_DEBUG !== "1" &&
    process.env.NOLO_DEBUG !== "1"
  ) {
    return;
  }
  console.error(`[nolo-local-runtime] ${event} ${JSON.stringify(fields)}`);
}

function summarizeOpenAiToolNames(tools: Array<Record<string, unknown>>) {
  return tools
    .map((tool) => {
      const fn = tool.function;
      return fn && typeof fn === "object" && "name" in fn && typeof fn.name === "string"
        ? fn.name
        : null;
    })
    .filter((name): name is string => Boolean(name));
}

function shouldExposeLocalPlatformTools(agentKey?: string) {
  return agentKey !== MIMO_MONTH_AGENT_KEY;
}

function addDefaultLightWebToolsForConfiguredAgents(
  toolNames: string[],
  agentConfig?: AgentRuntimeAgentConfig | null,
) {
  const explicitToolNames = Array.isArray((agentConfig as any)?.toolSurface?.explicitToolNames)
    ? (agentConfig as any).toolSurface.explicitToolNames
    : agentConfig?.toolNames;
  if (!Array.isArray(explicitToolNames) || explicitToolNames.length === 0) return toolNames;
  const webCapable = explicitToolNames.some((toolName) =>
    toolName === "fetchWebpage" ||
    toolName === "exa_search" ||
    toolName === "firecrawl_scrape" ||
    toolName === "firecrawl_search" ||
    toolName === "read_x_post" ||
    toolName === "read_xhs_profile" ||
    toolName.startsWith("browser_")
  );
  if (!webCapable) return toolNames;
  return [...new Set([...toolNames, ...TOOL_PACKS.LIGHT_WEB])];
}

function buildOpenAiTools(args: { agentKey?: string; toolNames?: string[]; env: EnvLike }) {
  const toolset = buildLocalWorkspaceToolsetForEnv(args);
  const exposePlatformTools = shouldExposeLocalPlatformTools(args.agentKey);
  return [
    ...buildLocalWorkspaceOpenAiTools({
      toolNames: toolset.toolNames,
      exposeShellTools: toolset.exposeShellTools,
      listFilesDescriptionVariant: resolveListFilesDescriptionVariant(args.env),
      listFilesParameterVariant: resolveListFilesParameterVariant(args.env),
      readFileDescriptionVariant: resolveReadFileDescriptionVariant(args.env),
      readFileParameterVariant: resolveReadFileParameterVariant(args.env),
      globFilesDescriptionVariant: resolveGlobFilesDescriptionVariant(args.env),
      globFilesParameterVariant: resolveGlobFilesParameterVariant(args.env),
      searchFilesDescriptionVariant: resolveSearchFilesDescriptionVariant(args.env),
      searchFilesParameterVariant: resolveSearchFilesParameterVariant(args.env),
    }),
    ...(exposePlatformTools ? buildServerPlatformOpenAiTools({ toolNames: args.toolNames }) : []),
    ...(exposePlatformTools ? buildNoloWorkspaceOpenAiTools({ toolNames: args.toolNames }) : []),
  ];
}

function buildLocalWorkspaceToolsetForEnv(args: { toolNames?: string[]; env: EnvLike }) {
  const toolset = buildLocalWorkspaceToolset({
    declaredToolNames: args.toolNames,
    exposeShellTools: true,
    useDeclaredToolNamesOnly: shouldUseDeclaredOnlyLocalWorkspaceTools(args.env),
  });
  return toolset;
}

function buildLocalPolicyToolNames(args: { toolNames?: string[]; env: EnvLike }) {
  return [
    ...buildLocalWorkspacePolicyToolNames({
      declaredToolNames: args.toolNames,
      exposeShellTools: true,
      useDeclaredToolNamesOnly: shouldUseDeclaredOnlyLocalWorkspaceTools(args.env),
    }),
    ...((args.toolNames ?? []).includes("read_x_post") ? ["read_x_post"] : []),
    ...((args.toolNames ?? []).includes("read_xhs_profile") ? ["read_xhs_profile"] : []),
    ...(args.toolNames ?? []).filter((name) => LOCAL_SERVER_TABLE_TOOL_NAME_SET.has(name)),
    ...filterNoloWorkspaceToolNames(args.toolNames),
  ];
}

function shouldUseDeclaredOnlyLocalWorkspaceTools(env: EnvLike) {
  const value = env.NOLO_LOCAL_WORKSPACE_TOOLSET || env.NOLO_LOCAL_TOOLSET_MODE || "";
  return value === "declared-only" || value === "declared";
}

function resolveGlobFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(env.NOLO_GLOBFILES_DESCRIPTION_VARIANT);
}

function resolveListFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(env.NOLO_LISTFILES_DESCRIPTION_VARIANT);
}

function resolveListFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(env.NOLO_LISTFILES_PARAMETER_VARIANT);
}

function resolveReadFileDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(env.NOLO_READFILE_DESCRIPTION_VARIANT);
}

function resolveReadFileParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(env.NOLO_READFILE_PARAMETER_VARIANT);
}

function resolveGlobFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(env.NOLO_GLOBFILES_PARAMETER_VARIANT);
}

function resolveSearchFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(env.NOLO_SEARCHFILES_DESCRIPTION_VARIANT);
}

function resolveSearchFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(env.NOLO_SEARCHFILES_PARAMETER_VARIANT);
}

function resolveLocalWorkspaceDescriptionVariant(value: string | undefined) {
  return value === "brief" || value === "strategy" || value === "workflow" || value === "antiShell"
    ? value
    : "strategy";
}

function resolveLocalWorkspaceParameterVariant(value: string | undefined) {
  return value === "minimal" || value === "scoped" || value === "rich" ? value : "rich";
}

function buildServerPlatformOpenAiTools(args: { toolNames?: string[] }) {
  const toolNames = new Set(args.toolNames ?? []);
  const tableTools = prepareTools(
    (args.toolNames ?? []).filter((name) => LOCAL_SERVER_TABLE_TOOL_NAME_SET.has(name)),
  );
  return [
    ...(toolNames.has("read_xhs_profile")
      ? [{
          type: "function",
          function: readXhsProfileFunctionSchema,
        }]
      : []),
    ...(toolNames.has("read_x_post")
      ? [{
          type: "function",
          function: readXPostFunctionSchema,
        }]
      : []),
    ...tableTools,
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

function isBuiltinNoloAgentConfig(agentConfig: AgentRuntimeAgentConfig | null | undefined) {
  const key = agentConfig?.key || agentConfig?.rawRecord?.dbKey || agentConfig?.rawRecord?.agentKey;
  const id = agentConfig?.rawRecord?.id;
  return isBuiltinNoloAgentRef(key) || isBuiltinNoloAgentRef(id);
}

function withResolvedRuntimeToolSurface(
  agentConfig: AgentRuntimeAgentConfig | null,
  env: EnvLike
) {
  if (!agentConfig) return agentConfig;
  const currentUserId = resolveLocalUserId(env);
  const rawRecord = (agentConfig as any).rawRecord ?? {};
  const ownerId =
    typeof rawRecord.userId === "string" && rawRecord.userId.trim()
      ? rawRecord.userId.trim()
      : null;
  const toolSurface = resolveRuntimeToolSurfaceForAgent({
    explicitToolNames: agentConfig.toolNames,
    currentUserId,
    agentOwnerId: ownerId,
    agentKey: rawRecord.dbKey ?? agentConfig.key,
    isPublic: !isBuiltinNoloAgentConfig(agentConfig) && rawRecord.isPublic === true,
    sharingLevel: typeof rawRecord.sharingLevel === "string" ? rawRecord.sharingLevel : null,
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

function resolveRuntimeServerUrl(env: EnvLike) {
  return (env.NOLO_SERVER_URL || env.NOLO_SERVER || env.BASE_URL || "").replace(/\/+$/, "");
}

function resolveRuntimeAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || env.NOLO_MACHINE_API_KEY || "";
}

function localTurnHasSubjectRefs(input: AgentRuntimeSaveTurnInput) {
  return Array.isArray(input.runtimeContext?.subjectRefs) && input.runtimeContext.subjectRefs.length > 0;
}

function prepareRemoteDialogEvidenceRecord(key: string, value: any) {
  const record = value && typeof value === "object" ? { ...value } : {};
  if (key.includes("-msg-") && typeof record.type !== "string") {
    record.type = "msg";
  }
  return record;
}

function normalizeRemoteString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRemoteStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(normalizeRemoteString)
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}

function normalizeRemoteSubjectRef(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = normalizeRemoteString(raw.kind);
  const id = normalizeRemoteString(raw.id);
  if (!kind || !id) return null;
  const role = normalizeRemoteString(raw.role);
  return { kind, id, ...(role ? { role } : {}) };
}

function mergeRemoteSubjectRefs(...groups: unknown[]) {
  const refs: Array<{ kind: string; id: string; role?: string }> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const ref = normalizeRemoteSubjectRef(item);
      if (!ref) continue;
      const key = `${ref.kind}\0${ref.id}\0${ref.role ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

function resolveParentAgentKeyFromDialog(parentDialog: Record<string, any>) {
  return normalizeRemoteString(parentDialog.primaryAgentKey) ??
    normalizeRemoteString(parentDialog.agentKey) ??
    (Array.isArray(parentDialog.cybots)
      ? parentDialog.cybots.map(normalizeRemoteString).find(Boolean)
      : undefined);
}

function clipLocalWakeEvidence(value: unknown, max = 1200) {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function buildLocalParentWakeMessage(args: {
  childAgentKey: string;
  childDialogId: string;
  childDialogKey: string;
  childEvidenceSummary?: string;
}) {
  return [
    "A child agent dialog you started has reached a terminal status.",
    "",
    `childDialogId: ${args.childDialogId}`,
    `childDialogKey: ${args.childDialogKey}`,
    `childAgentKey: ${args.childAgentKey}`,
    "status: done",
    ...(args.childEvidenceSummary
      ? [
          "",
          "childEvidenceSummary:",
          args.childEvidenceSummary,
        ]
      : []),
    "",
    "Read the childEvidenceSummary and decide the next step yourself. This wake came from a local CLI run, so completion evidence is the synced child dialog, subjectRefs, commits, artifacts, and test output rather than a server-side child process.",
  ].join("\n");
}

async function postRemoteRecord(args: {
  authToken: string;
  data: any;
  fetchImpl: typeof fetch;
  key: string;
  serverUrl: string;
  userId: string;
}) {
  const response = await args.fetchImpl(`${args.serverUrl}/api/v1/db/write/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.authToken}`,
    },
    body: JSON.stringify({
      customKey: args.key,
      userId: args.userId,
      data: prepareRemoteDialogEvidenceRecord(args.key, args.data),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`remote dialog evidence write failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
}

async function readRemoteRecord(args: {
  authToken: string;
  fetchImpl: typeof fetch;
  key: string;
  serverUrl: string;
}) {
  const response = await args.fetchImpl(
    `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(args.key)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
      },
    },
  );
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload?.data && typeof payload.data === "object" ? payload.data : null;
}

async function maybeWakeParentDialogAfterLocalSync(args: {
  authToken: string;
  childDialogKey: string;
  childDialogRecord: Record<string, any>;
  fetchImpl: typeof fetch;
  input: AgentRuntimeSaveTurnInput;
  serverUrl: string;
  userId: string;
}) {
  if (args.input.runtimeContext?.parentWakeOnTerminal !== true) return;
  if (args.childDialogRecord.parentWake?.terminalNotifiedAt) return;
  const parentDialogId = normalizeRemoteString(args.childDialogRecord.parentDialogId);
  if (!parentDialogId) return;

  const parentDialogKey = `dialog-${args.userId}-${parentDialogId}`;
  const parentDialog = await readRemoteRecord({
    authToken: args.authToken,
    fetchImpl: args.fetchImpl,
    key: parentDialogKey,
    serverUrl: args.serverUrl,
  });
  if (!parentDialog) return;
  const parentAgentKey = resolveParentAgentKeyFromDialog(parentDialog);
  if (!parentAgentKey) return;

  const childDialogId = normalizeRemoteString(args.childDialogRecord.id);
  if (!childDialogId) return;
  const subjectRefs = mergeRemoteSubjectRefs(
    args.childDialogRecord.subjectRefs,
    [{ kind: "dialog", id: childDialogId, role: "completed-child-dialog" }],
  );
  const allowedChildAgentKeys = normalizeRemoteStringList(args.input.runtimeContext?.allowedChildAgentKeys);
  const allowedToolNames = normalizeRemoteStringList(args.input.runtimeContext?.allowedToolNames);
  const wakeResponse = await args.fetchImpl(`${args.serverUrl}/api/agent/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.authToken}`,
    },
    body: JSON.stringify({
      agentKey: parentAgentKey,
      userInput: buildLocalParentWakeMessage({
        childAgentKey: args.childDialogRecord.primaryAgentKey ?? args.input.agentKey,
        childDialogId,
        childDialogKey: args.childDialogKey,
        childEvidenceSummary: clipLocalWakeEvidence(args.input.result.content),
      }),
      background: true,
      continueDialogId: parentDialogId,
      runtimeContext: {
        surface: "cli",
        host: "terminal",
        runtime: "bun",
        entrypoint: "agent-runtime:parent-child-terminal-wake",
        subjectRefs,
        ...(allowedChildAgentKeys.length ? { allowedChildAgentKeys } : {}),
        ...(allowedToolNames.length ? { allowedToolNames } : {}),
      },
    }),
  });
  if (!wakeResponse.ok) {
    const text = await wakeResponse.text().catch(() => "");
    throw new Error(`parent dialog wake failed: HTTP ${wakeResponse.status} ${text.slice(0, 500)}`);
  }

  const notifiedAt = Date.now();
  await postRemoteRecord({
    authToken: args.authToken,
    data: {
      ...args.childDialogRecord,
      parentWake: {
        terminalNotifiedAt: notifiedAt,
        terminalStatus: "done",
        parentDialogId,
        childDialogId,
      },
      updatedAt: new Date(notifiedAt).toISOString(),
    },
    fetchImpl: args.fetchImpl,
    key: args.childDialogKey,
    serverUrl: args.serverUrl,
    userId: args.userId,
  });
}

async function syncLocalDialogEvidenceToRemote(args: {
  env: EnvLike;
  fetchImpl: typeof fetch;
  input: AgentRuntimeSaveTurnInput;
  ops: Array<{ type: "put"; key: string; value: any }>;
  output?: { write(chunk: string): unknown };
  userId: string;
}) {
  const serverUrl = resolveRuntimeServerUrl(args.env);
  const authToken = resolveRuntimeAuthToken(args.env);
  if (!serverUrl || !authToken) {
    return { attempted: false as const };
  }

  const orderedOps = [
    ...args.ops.filter((op) => op.type === "put" && op.key.includes("-msg-")),
    ...args.ops.filter((op) => op.type === "put" && !op.key.includes("-msg-")),
  ];

  for (const op of orderedOps) {
    if (op.type !== "put") continue;
    await postRemoteRecord({
      authToken,
      data: op.value,
      fetchImpl: args.fetchImpl,
      key: op.key,
      serverUrl,
      userId: args.userId,
    });
  }

  const childDialogOp = args.ops.find((op) => op.type === "put" && !op.key.includes("-msg-"));
  const childDialogRecord = childDialogOp?.value && typeof childDialogOp.value === "object"
    ? childDialogOp.value
    : null;
  if (childDialogOp && childDialogRecord) {
    try {
      await maybeWakeParentDialogAfterLocalSync({
        authToken,
        childDialogKey: childDialogOp.key,
        childDialogRecord,
        fetchImpl: args.fetchImpl,
        input: args.input,
        serverUrl,
        userId: args.userId,
      });
    } catch (error) {
      args.output?.write(
        `[nolo] Parent dialog wake failed; synced local child evidence remains queryable: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  return { attempted: true as const };
}

function buildServerPlatformToolExecutors(args: {
  env: EnvLike;
  fetchImpl: typeof fetch;
}) {
  const postServer = async (path: string, body: object) => {
    const serverUrl = resolveRuntimeServerUrl(args.env);
    const authToken = resolveRuntimeAuthToken(args.env);
    if (!serverUrl) throw new Error("server platform tools require NOLO_SERVER_URL, NOLO_SERVER, or BASE_URL.");
    if (!authToken) throw new Error("server platform tools require AUTH_TOKEN or NOLO_MACHINE_API_KEY.");
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
      throw new Error(`server platform tool bridge failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    return text;
  };
  const guardExplicitTableCapture = (call: any) => {
    if (inferCaptureIntent(String(call.userInput ?? "")) === "strong") return null;
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
          toolName === "createTable" ? "/api/table/create"
          : toolName === "addTableRow" ? "/api/table/add-row"
          : toolName === "addTableRows" ? "/api/table/add-rows"
          : toolName === "updateTableRow" ? "/api/table/update-row"
          : "/api/table/update-rows";
        const content = await postServer(path, parsed);
        return {
          content,
          metadata: { serverPlatformTool: true, tableWrite: true },
        };
      },
    ]),
  );
  return tableExecutors;
}

function buildLocalToolExecutors(args: {
  workspaceRoot: string;
  env: EnvLike;
  fetchImpl: typeof fetch;
  localToolExecutors?: CliLocalRuntimeAdapterDeps["localToolExecutors"];
  readXPost?: CliLocalRuntimeAdapterDeps["readXPost"];
  readXhsProfile?: CliLocalRuntimeAdapterDeps["readXhsProfile"];
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
}) {
  return {
    ...createLocalWorkspaceToolExecutors({
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      commandOutputLimit: args.commandOutputLimit,
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
        try { return JSON.parse(call.arguments || "{}"); } catch { return {}; }
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
        try { return JSON.parse(call.arguments || "{}"); } catch { return {}; }
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
    ...(args.localToolExecutors ?? {}),
  };
}

async function resolveStore(deps: CliLocalRuntimeAdapterDeps) {
  if (deps.store) return deps.store;
  return createCliHybridRecordStore({
    db: deps.db ?? await defaultLocalRuntimeDb(),
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
}

async function readAgentFromStore(args: {
  store: HybridRecordStore;
  agentRef: string;
  userId: string;
}): Promise<AgentRuntimeAgentConfig | null> {
  for (const key of buildLocalAgentLookupKeys(args)) {
    const record = await args.store.read(key, {
      remote: shouldReadAgentKeyRemotely(key),
    });
    if (!record || typeof record !== "object") continue;
    return resolveAgentRuntimeConfigFromRecord(key, record);
  }
  const normalizedRef = normalizeRemoteString(args.agentRef)?.toLowerCase().replace(/\s+/g, " ");
  if (!normalizedRef) return null;
  try {
    const iterator = args.store.iterator({ gte: "agent-", lte: "agent-\uffff" });
    for await (const [key, record] of iterator) {
      if (!record || typeof record !== "object") continue;
      const handle = normalizeRemoteString((record as any).handle)?.toLowerCase().replace(/\s+/g, " ");
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
  const prefix = `dialog-${args.dialogId}-msg-`;
  const iterator = args.store.iterator({ gte: prefix, lte: `${prefix}\uffff` });
  for await (const [, value] of iterator) {
    const message = localDialogMessageRecordToRuntimeMessage(value);
    if (message) messages.push(message);
  }
  return messages;
}

async function writeDialog(args: {
  store: HybridRecordStore;
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  now: () => number;
  createId: () => string;
  env: EnvLike;
  fetchImpl: typeof fetch;
  output?: { write(chunk: string): unknown };
  cwd?: string;
}) {
  let existingDialog: any = null;
  if (args.input.continueDialogId) {
    const dialogKey = `dialog-${args.userId}-${args.input.continueDialogId}`;
    existingDialog = await args.store.read(dialogKey);
  }
  const plan = buildLocalDialogWritePlan({
    input: args.input,
    userId: args.userId,
    now: args.now(),
    createId: args.createId,
    existingDialog,
    cwd: args.cwd,
  });
  await args.store.batch(plan.ops);
  const shouldSyncRemoteEvidence = localTurnHasSubjectRefs(args.input);
  try {
    const syncResult = shouldSyncRemoteEvidence
      ? await syncLocalDialogEvidenceToRemote({
          env: args.env,
          fetchImpl: args.fetchImpl,
          input: args.input,
          ops: plan.ops,
          output: args.output,
          userId: args.userId,
        })
      : { attempted: false as const };
    if (shouldSyncRemoteEvidence && !syncResult.attempted) {
      args.output?.write(
        "[nolo] Local dialog evidence is local-only; set NOLO_SERVER and AUTH_TOKEN to make subjectRefs remotely queryable.\n"
      );
    }
  } catch (error) {
    if (shouldSyncRemoteEvidence) {
      throw error;
    }
    args.output?.write(
      `[nolo] Remote dialog evidence sync failed; local dialog only: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }
  return { dialogId: plan.dialogId };
}

export function createCliLocalRuntimeAdapter(
  deps: CliLocalRuntimeAdapterDeps
): AgentRuntimeHostAdapter {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? createFallbackId;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const loopbackRequest = deps.loopbackRequest ?? (deps.fetchImpl ? undefined : defaultLoopbackRequest);
  const userId = resolveLocalUserId(deps.env);
  const localToolBudgets = parseLocalToolBudgets(deps.env);
  const localToolUsage = new Map<string, number>();
  let activeAgentToolNames: string[] = [];
  const workspaceRoot = deps.cwd ?? process.cwd();
  let runtimeToolExecutionLimits: ReturnType<typeof resolveLocalWorkspaceExecutorOptionsFromPolicy> = {};
  let localToolExecutors = buildLocalToolExecutors({
    workspaceRoot,
    env: deps.env,
    fetchImpl,
    localToolExecutors: deps.localToolExecutors,
    readXPost: deps.readXPost,
    readXhsProfile: deps.readXhsProfile,
    ...runtimeToolExecutionLimits,
  });

  return {
    host: "cli",
    capabilities: ["leveldb-agent-config", "local-provider", "leveldb-persistence", "local-tools"],
    loadAgentConfig: async (agentRef) => {
      const storedAgentConfig = await readAgentFromStore({
        agentRef,
        store: await resolveStore(deps),
        userId,
      });
      const fallbackLocalCliAgentConfig =
        storedAgentConfig ? null : resolveBuiltinLocalCliAgentConfig(agentRef, userId);
      const agentConfig = withResolvedRuntimeToolSurface(
        storedAgentConfig ?? fallbackLocalCliAgentConfig,
        deps.env
      );
      const requestedToolNames = agentConfig
        ? addDefaultLightWebToolsForConfiguredAgents(
            resolveRequestedRuntimeToolNames({ agentConfig }),
            agentConfig,
          )
        : [];
      activeAgentToolNames = buildLocalPolicyToolNames({
        toolNames: requestedToolNames,
        env: deps.env,
      });
      runtimeToolExecutionLimits = resolveLocalWorkspaceExecutorOptionsFromPolicy(
        resolveCurrentRunRuntimeToolPolicy(agentConfig),
      );
      localToolExecutors = buildLocalToolExecutors({
        workspaceRoot,
        env: deps.env,
        fetchImpl,
        localToolExecutors: deps.localToolExecutors,
        readXPost: deps.readXPost,
        readXhsProfile: deps.readXhsProfile,
        ...runtimeToolExecutionLimits,
      });
      return agentConfig;
    },
    loadDialogHistory: async (dialogId) => readDialogMessages({
      dialogId,
      store: await resolveStore(deps),
    }),
    saveTurn: async (input) => writeDialog({
      store: await resolveStore(deps),
      input,
      userId,
      now,
      createId,
      env: deps.env,
      fetchImpl,
      output: deps.output,
      cwd: workspaceRoot,
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
            const executeCli = deps.executeCli ?? (defaultExecuteCli as LocalCliExecutor);
            const imageUrls = collectCliProviderImageInputs(messages);
            const imageInputs: CliImageInput[] | undefined =
              imageUrls.length > 0
                ? imageUrls.map((url) => ({ source: url }))
                : undefined;
            const prompt = buildPromptForCliProvider(messages);
            try {
              const reasoningEffort =
                agentConfig.reasoning_effort || agentConfig.reasoningEffort;
              const result = await executeCli(provider, prompt, {
                ...(agentConfig.model ? { model: agentConfig.model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
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
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                `Local CLI provider "${provider}" is unavailable or failed: ${message}`
              );
            }
          },
        };
      }

      if (shouldUsePlatformChatProvider(deps.env, agentConfig)) {
        const providerConfig = resolvePlatformChatProviderConfig({
          agentConfig,
          env: deps.env,
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
          customProviderEndpoint: summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
        });
        return {
          model: providerConfig.model,
          complete: async (messages, options) => {
            const requestedToolNames = addDefaultLightWebToolsForConfiguredAgents(
              resolveRequestedRuntimeToolNames({ agentConfig }),
              agentConfig,
            );
            const tools = buildOpenAiTools({
              agentKey: agentConfig.key,
              toolNames: requestedToolNames,
              env: deps.env,
            });
            const timeoutSignal = buildRequestTimeoutSignal(options?.timeoutMs);
            const usesResponsesApi = providerConfig.endpoint.includes("/responses");
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
              timeoutMs: options?.timeoutMs ?? null,
              stream,
            });
            try {
              const res = await fetchWithTransientRetry(fetchImpl, request.url, {
                ...request.init,
                ...(timeoutSignal ? { signal: timeoutSignal.signal } : {}),
              }, {
                sleep: deps.sleep,
                loopbackRequest,
              });
              if (!res.ok) {
                const raw = await res.text().catch(() => "");
                const data = parsePlatformChatCompletionData(raw);
                throw new Error(`platform provider failed: HTTP ${res.status} ${JSON.stringify(data)}`);
              }
              if (stream && options?.onTextDelta) {
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
                  ...(streamed.tool_calls ? { tool_calls: streamed.tool_calls } : {}),
                  ...(streamed.reasoning_content ? { reasoning_content: streamed.reasoning_content } : {}),
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
            } finally {
              timeoutSignal?.clear();
            }
          },
        };
      }

      const providerConfig = resolveCliOpenAiProviderConfig({
        agentConfig,
        env: deps.env,
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
        customProviderEndpoint: summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
      });
      return {
        model: providerConfig.model,
        complete: async (messages, options) => {
          const requestedToolNames = addDefaultLightWebToolsForConfiguredAgents(
            resolveRequestedRuntimeToolNames({ agentConfig }),
            agentConfig,
          );
          const tools = buildOpenAiTools({
            agentKey: agentConfig.key,
            toolNames: requestedToolNames,
            env: deps.env,
          });
          const timeoutSignal = buildRequestTimeoutSignal(options?.timeoutMs);
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
            timeoutMs: options?.timeoutMs ?? null,
            stream,
          });
          try {
            const result = await executeOpenAiCompatibleChatCompletion({
              providerConfig,
              messages,
              tools,
              fetchImpl: (url, init) =>
                fetchWithTransientRetry(fetchImpl, url, init, {
                  sleep: deps.sleep,
                  loopbackRequest,
                }),
              stream,
              onTextDelta: options?.onTextDelta,
              signal: timeoutSignal?.signal,
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
          } finally {
            timeoutSignal?.clear();
          }
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
