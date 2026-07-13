// Pure helpers used by `handleConnectorRunMessage` in
// machineWsRunDispatch.ts. Extracted so the orchestration entry can stay
// focused on DI and message dispatch.
//
// No side effects on the surrounding CLI process: logging helpers write
// to `console.error` for diagnostic purposes, the artifact builder does
// not touch disk, and the policy parsers are pure.

import type { MachineRunPermissionPolicy } from "../ai/agent/machineRunPermissions";
import { runLocalAgentTurn, type LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { resolveLocalRuntimeEnvFromPolicy } from "../agent-runtime/runtimeToolPolicy";
import {
  resolveMachineRunPermissionPolicy as defaultResolveMachineRunPermissionPolicy,
} from "../ai/agent/machineRunPermissions";
import {
  collectConnectorRunArtifact as defaultCollectConnectorRunArtifact,
  readConnectorGitHead as defaultReadConnectorGitHead,
  resolveConnectorRunCwd as defaultResolveConnectorRunCwd,
} from "./connectorRunArtifact";
import { createCliLocalRuntimeAdapter } from "./client/localRuntimeAdapter";
import type { CliFetchImpl } from "./cliFetch";
import {
  materializeLargeConnectorPrompt as defaultMaterializeLargeConnectorPrompt,
  readRuntimePromptPageMeta as defaultReadRuntimePromptPageMeta,
} from "./machineWsPromptMaterialization";

type EnvLike = Record<string, string | undefined>;

export type LocalCliExecutor = (
  provider: string,
  prompt: string,
  options: {
    model?: string;
    timeout?: number;
    cwd?: string;
    yolo?: boolean;
    env?: EnvLike;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    imageInputs?: Array<{ source: string; materializedPath?: string }>;
  }
) => Promise<{ text: string; raw?: string; elapsed?: number }>;

export type ConnectorRuntimePolicy = {
  runtimeTools?: string[];
  agentTools?: string[];
  workspace?: {
    mode?: string;
    cwd?: string;
  };
  shell?: {
    enabled?: boolean;
    mode?: string;
  };
};

export type ConnectorRunProgress = {
  eventType?: LocalAgentToolEvent["type"];
  toolCallCount?: number;
  toolResultCount?: number;
  lastToolNames?: string[];
  provider?: string;
  promptBytes?: number;
  promptHash?: string;
  promptRef?: string;
  promptPageKey?: string;
  promptPageHash?: string;
  requestId?: string;
  workspaceRoot?: string;
  workspaceKind?: string;
  message?: string;
  updatedAt?: number;
};

export type PermissionPolicy = MachineRunPermissionPolicy;

export type MachineWsRunDispatchDeps = {
  assertMachineRunAllowed?: typeof defaultResolveMachineRunPermissionPolicy extends never
    ? never
    : (input: string, policy: PermissionPolicy) => void;
  resolveMachineRunPermissionPolicy?: typeof defaultResolveMachineRunPermissionPolicy;
  resolveConnectorRunCwd?: typeof defaultResolveConnectorRunCwd;
  readConnectorGitHead?: typeof defaultReadConnectorGitHead;
  collectConnectorRunArtifact?: typeof defaultCollectConnectorRunArtifact;
  materializeLargeConnectorPrompt?: typeof defaultMaterializeLargeConnectorPrompt;
  readRuntimePromptPageMeta?: typeof defaultReadRuntimePromptPageMeta;
  buildConnectorCliPrompt?: (
    agentConfig: Record<string, unknown>,
    userInput: string,
    bridgeArgs: {
      agentKey: string;
      runtimeContext: unknown;
    },
    permissionPolicy?: PermissionPolicy
  ) => string;
  runConnectorLocalRuntimeAgent?: (args: {
    parsed: Record<string, unknown>;
    runtimeEnv: EnvLike;
    cwd: string;
    fetchImpl?: CliFetchImpl;
    onProgress?: (progress: ConnectorRunProgress) => void;
  }) => Promise<ConnectorLocalRunResult>;
};

export type ConnectorLocalRunResult = {
  content: string;
  model: string;
  trace?: unknown[];
  runtimeWorkspaceRoot?: string;
};

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function logConnectorRun(message: string, fields: Record<string, unknown> = {}) {
  console.error(`[nolo-connector] ${message} ${JSON.stringify(fields)}`);
}

export function summarizeRuntimePolicyForLogs(policy?: ConnectorRuntimePolicy) {
  return {
    hasPolicy: Boolean(policy),
    runtimeTools: policy?.runtimeTools ?? [],
    agentTools: policy?.agentTools ?? [],
    workspaceMode: policy?.workspace?.mode ?? null,
    workspaceCwd: policy?.workspace?.cwd ?? null,
    shellEnabled: policy?.shell?.enabled ?? null,
  };
}

export function summarizeEndpoint(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export function summarizeAgentConfigForLogs(agentConfig: unknown) {
  const config = isRecord(agentConfig) ? agentConfig : {};
  const runtimeBinding = isRecord(config.runtimeBinding) ? config.runtimeBinding : {};
  return {
    apiSource: readField(config, "apiSource") ?? null,
    provider: readField(config, "provider") ?? null,
    cliProvider: readField(config, "cliProvider") ?? null,
    model: readField(config, "model") ?? null,
    customProviderEndpoint: summarizeEndpoint(readField(config, "customProviderUrl")) ?? null,
    useServerProxy: readField(config, "useServerProxy") ?? null,
    skipLocalRuntimeEnsure: readField(config, "skipLocalRuntimeEnsure") ?? null,
    hasApiKey: isNonEmptyString(readField(config, "apiKey")),
    apiKeyHeader: readField(config, "apiKeyHeader") ?? null,
    hasApiKeyFromAgentKey: (() => {
      const value = readField(config, "apiKeyFromAgentKey");
      return typeof value === "string" && value.length > 0;
    })(),
    runtimeBindingKind: readField(runtimeBinding, "kind") ?? null,
    runtimeMachineId: readField(runtimeBinding, "machineId") ?? null,
    connectorSurface: readField(runtimeBinding, "connectorSurface") ?? readField(runtimeBinding, "surface") ?? null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readField(record: unknown, key: string): unknown {
  if (!isRecord(record)) return undefined;
  return record[key];
}

export function runtimePolicyFromConnectorPayload(parsed: unknown): ConnectorRuntimePolicy | undefined {
  const obj = isRecord(parsed) ? parsed : {};
  const payload = isRecord(obj.payload) ? obj.payload : {};
  const meta = isRecord(payload.meta) ? payload.meta : {};
  const fromMeta = readField(meta, "runtimeToolPolicySnapshot");
  const agentConfig = isRecord(payload.agentConfig) ? payload.agentConfig : {};
  const fromAgent = readField(agentConfig, "runtimeToolPolicy");
  const policy = isRecord(fromMeta) ? fromMeta : isRecord(fromAgent) ? fromAgent : null;
  return policy ? (policy as ConnectorRuntimePolicy) : undefined;
}

export function requestsLocalWorkspaceRuntime(policy?: ConnectorRuntimePolicy) {
  return Boolean(
    Array.isArray(policy?.runtimeTools) && policy.runtimeTools.length > 0,
  );
}

export function isMachineBoundLocalCustomProvider(agentConfig: unknown) {
  const config = isRecord(agentConfig) ? agentConfig : {};
  const runtimeBinding = isRecord(config.runtimeBinding) ? config.runtimeBinding : {};
  const machineIdRaw = readField(runtimeBinding, "machineId");
  const machineId = typeof machineIdRaw === "string" ? machineIdRaw.trim() : "";
  const providerUrlRaw = readField(config, "customProviderUrl");
  const providerUrl = typeof providerUrlRaw === "string" ? providerUrlRaw.trim() : "";
  if (!machineId || !providerUrl) return false;
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function hasExplicitMachinePermissions(agentConfig: unknown) {
  const config = isRecord(agentConfig) ? agentConfig : {};
  const runtimeBinding = isRecord(config.runtimeBinding) ? config.runtimeBinding : {};
  return Boolean(
    isRecord(readField(config, "machinePermissions")) ||
      isRecord(readField(runtimeBinding, "permissions")) ||
      isRecord(readField(runtimeBinding, "machinePermissions")) ||
      isRecord(readField(readField(config, "boundRuntimeMachine"), "permissions"))
  );
}

export function runtimeWorkspacePermissionPolicy(
  runtimePolicy: ConnectorRuntimePolicy | undefined,
  runtimeEnv: EnvLike,
  cwd: string
): PermissionPolicy | null {
  void runtimeEnv;
  if (!requestsLocalWorkspaceRuntime(runtimePolicy)) return null;
  return {
    mode: "full_access",
    allowFilesystemRead: true,
    allowFilesystemWrite: true,
    allowShell:
      Array.isArray(runtimePolicy?.runtimeTools) &&
      runtimePolicy.runtimeTools.includes("execShell"),
    writableRoots: [cwd],
  };
}

export function scopePermissionPolicyToRuntimeWorkspace(
  policy: PermissionPolicy,
  runtimePolicy: ConnectorRuntimePolicy | undefined,
  cwd: string
): PermissionPolicy {
  if (!requestsLocalWorkspaceRuntime(runtimePolicy)) return policy;
  return {
    ...policy,
    writableRoots: policy.allowFilesystemWrite ? [cwd] : [],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readToolName(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return "";
  // OpenAI / Anthropic tool shapes: `{ name }` or `{ function: { name } }`.
  const direct = readField(item, "name");
  if (isNonEmptyString(direct)) return direct;
  const functionField = readField(item, "function");
  if (isRecord(functionField)) {
    const inner = readField(functionField, "name");
    if (isNonEmptyString(inner)) return inner;
  }
  return "";
}

export function mergeToolNames(...values: unknown[]) {
  const names: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const name = readToolName(item);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function localRuntimeEnvFromPolicy(runtimeEnv: EnvLike, policy?: ConnectorRuntimePolicy): EnvLike {
  return resolveLocalRuntimeEnvFromPolicy(runtimeEnv, policy as any);
}

export function forwardedUserAuthToken(parsed: unknown): string {
  const obj = isRecord(parsed) ? parsed : {};
  const payload = isRecord(obj.payload) ? obj.payload : {};
  const meta = isRecord(payload.meta) ? payload.meta : {};
  const value = readField(meta, "userAuthToken");
  return typeof value === "string" ? value.trim() : "";
}

export function withForwardedUserAuthToken(runtimeEnv: EnvLike, parsed: unknown): EnvLike {
  const userAuthToken = forwardedUserAuthToken(parsed);
  return userAuthToken ? { ...runtimeEnv, AUTH_TOKEN: userAuthToken } : runtimeEnv;
}

export function runtimeWorkspaceRootFromTrace(trace: unknown): string | undefined {
  if (!Array.isArray(trace)) return undefined;
  for (const message of trace) {
    if (!isRecord(message)) continue;
    const metadataValue = readField(message, "tool_result_metadata");
    const metadata = isRecord(metadataValue) ? metadataValue : null;
    const rootRaw = metadata ? readField(metadata, "workspaceRoot") : undefined;
    const workspaceRoot = typeof rootRaw === "string" ? rootRaw.trim() : "";
    if (workspaceRoot) return workspaceRoot;
  }
  return undefined;
}

export function buildArtifactProgress(args: {
  artifacts: unknown;
  runtimePolicy?: ConnectorRuntimePolicy;
  workspaceRoot: string;
  workspaceKind?: string;
}): ConnectorRunProgress | null {
  if (!isRecord(args.artifacts)) return null;
  const changedFilesRaw = readField(args.artifacts, "changedFiles");
  const changedFiles = Array.isArray(changedFilesRaw) ? changedFilesRaw : [];
  const statusShortRaw = readField(args.artifacts, "statusShort");
  const statusShort = typeof statusShortRaw === "string" ? statusShortRaw.trim() : "";
  if (changedFiles.length === 0 && !statusShort) return null;
  const runtimeToolsRaw = args.runtimePolicy?.runtimeTools;
  const runtimeTools = Array.isArray(runtimeToolsRaw) ? runtimeToolsRaw : [];
  const shellTool = runtimeTools.includes("execShell") ? "execShell" : "workspaceArtifact";
  return {
    eventType: "tool-result",
    toolCallCount: 1,
    toolResultCount: 1,
    lastToolNames: [shellTool],
    workspaceRoot: args.workspaceRoot,
    ...(args.workspaceKind ? { workspaceKind: args.workspaceKind } : {}),
    message: statusShort || `${changedFiles.length} changed file(s)`,
    updatedAt: Date.now(),
  };
}

export async function defaultRunConnectorLocalRuntimeAgent(args: {
  parsed: unknown;
  runtimeEnv: EnvLike;
  cwd: string;
  fetchImpl?: CliFetchImpl;
  onProgress?: (progress: ConnectorRunProgress) => void;
}): Promise<ConnectorLocalRunResult> {
  const obj = isRecord(args.parsed) ? args.parsed : {};
  const payload = isRecord(obj.payload) ? obj.payload : {};
  const agentKeyRaw = readField(payload, "agentKey");
  const agentKey = typeof agentKeyRaw === "string" ? agentKeyRaw : "";
  const agentConfigRaw = readField(payload, "agentConfig");
  const payloadAgentConfig = isRecord(agentConfigRaw) ? agentConfigRaw : {};
  const policy = runtimePolicyFromConnectorPayload(args.parsed);
  const toolNames = mergeToolNames(
    readField(payloadAgentConfig, "toolNames"),
    readField(payloadAgentConfig, "tools"),
    policy?.agentTools,
    policy?.runtimeTools,
  );
  const apiSourceRaw = readField(payloadAgentConfig, "apiSource");
  const providerRaw = readField(payloadAgentConfig, "provider");
  const agentRecord: Record<string, unknown> = {
    ...payloadAgentConfig,
    dbKey: agentKey,
    id: agentKey,
    key: agentKey,
    apiSource: typeof apiSourceRaw === "string" ? apiSourceRaw : "platform",
    provider: typeof providerRaw === "string" ? providerRaw : (typeof apiSourceRaw === "string" ? apiSourceRaw : "openai"),
    toolNames,
    ...(policy ? { runtimeToolPolicy: policy } : {}),
  };
  const store = new Map<string, unknown>([
    [agentKey, agentRecord],
    [`agent-${args.runtimeEnv.NOLO_USER_ID || "local"}-${agentKey}`, agentRecord],
    [`agent-${args.runtimeEnv.NOLO_LOCAL_USER_ID || args.runtimeEnv.NOLO_USER_ID || "local"}-${agentKey}`, agentRecord],
  ]);
  const env = localRuntimeEnvFromPolicy(
    withForwardedUserAuthToken(args.runtimeEnv, args.parsed),
    policy
  );
  logConnectorRun("agent.run.local-runtime.env", {
    requestId: readField(obj, "requestId"),
    agentKey,
    cwd: args.cwd,
    ...summarizeRuntimePolicyForLogs(policy),
  });
  const adapter = createCliLocalRuntimeAdapter({
    env,
    cwd: args.cwd,
    fetchImpl: args.fetchImpl ?? fetch,
    store: {
      read: async (key) => store.get(key) ?? null,
      write: async (key, value) => {
        store.set(key, value);
        return value;
      },
      batch: async (ops) => {
        for (const op of ops) {
          if (op.type === "put") store.set(op.key, op.value);
        }
      },
      iterator: async function* (options) {
        const keys = [...store.keys()].sort();
        for (const key of keys) {
          if (key < options.gte) continue;
          if (options.lte && key > options.lte) continue;
          if (options.lt && key >= options.lt) continue;
          yield [key, store.get(key)];
        }
      },
    },
  });
  let toolCallCount = 0;
  let toolResultCount = 0;
  const lastToolNames: string[] = [];
  let runtimeWorkspaceRoot: string | undefined;
  let runtimeWorkspaceKind: string | undefined;
  const noteToolName = (toolName: string) => {
    if (!toolName) return;
    const existingIndex = lastToolNames.indexOf(toolName);
    if (existingIndex >= 0) lastToolNames.splice(existingIndex, 1);
    lastToolNames.push(toolName);
    while (lastToolNames.length > 8) lastToolNames.shift();
  };
  const userInputRaw = readField(payload, "userInput");
  const continueDialogIdRaw = readField(payload, "continueDialogId");
  const result = await runLocalAgentTurn({
    adapter,
    agentRef: agentKey,
    input: typeof userInputRaw === "string" ? userInputRaw : "",
    continueDialogId:
      typeof continueDialogIdRaw === "string" ? continueDialogIdRaw : undefined,
    onToolEvent: (event) => {
      if (event.type === "tool-call") toolCallCount += 1;
      if (event.type === "tool-result") toolResultCount += 1;
      noteToolName(event.toolName);
      const metadata = isRecord(event.metadata) ? event.metadata : {};
      const rootRaw = readField(metadata, "workspaceRoot");
      if (typeof rootRaw === "string" && rootRaw.trim()) {
        runtimeWorkspaceRoot = rootRaw.trim();
      }
      const kindRaw = readField(metadata, "workspaceKind");
      if (typeof kindRaw === "string" && kindRaw.trim()) {
        runtimeWorkspaceKind = kindRaw.trim();
      }
      args.onProgress?.({
        eventType: event.type,
        toolCallCount,
        toolResultCount,
        lastToolNames: [...lastToolNames],
        ...(runtimeWorkspaceRoot ? { workspaceRoot: runtimeWorkspaceRoot } : {}),
        ...(runtimeWorkspaceKind ? { workspaceKind: runtimeWorkspaceKind } : {}),
        ...(event.message ? { message: event.message } : {}),
        updatedAt: Date.now(),
      });
    },
  });
  return {
    ...result,
    runtimeWorkspaceRoot: runtimeWorkspaceRootFromTrace(result.trace) ?? runtimeWorkspaceRoot,
  };
}

export function normalizeConnectorRunTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

type ConnectorUserInputPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | Record<string, unknown>;

function isConnectorUserInput(value: unknown): value is ConnectorUserInputPart[] {
  return Array.isArray(value);
}

function readConnectorTextPart(part: ConnectorUserInputPart): string | null {
  if (!isRecord(part)) return null;
  const text = readField(part, "text");
  if (readField(part, "type") === "text" && isNonEmptyString(text)) {
    return text;
  }
  return null;
}

function readConnectorImageUrlPart(part: ConnectorUserInputPart): string | null {
  if (!isRecord(part)) return null;
  if (readField(part, "type") !== "image_url") return null;
  const imageUrlValue = readField(part, "image_url");
  if (!isRecord(imageUrlValue)) return null;
  const url = readField(imageUrlValue, "url");
  if (typeof url !== "string" || !url.trim()) return null;
  return url.trim();
}

/**
 * Extract multimodal content from a connector payload's `userInput`.
 * - If `userInput` is a string, returns it directly with no images.
 * - If `userInput` is a multimodal content array
 *   (`[{ type: "text" }, { type: "image_url" }]`), extracts the text and
 *   image_url parts.
 * - Any other shape coerces to a string with empty imageUrls.
 */
export function extractMultimodalUserInput(userInput: unknown): {
  text: string;
  imageUrls: string[];
} {
  if (typeof userInput === "string") {
    return { text: userInput, imageUrls: [] };
  }
  if (!isConnectorUserInput(userInput)) {
    return { text: String(userInput ?? ""), imageUrls: [] };
  }

  const textParts: string[] = [];
  const imageUrls: string[] = [];

  for (const part of userInput) {
    const text = readConnectorTextPart(part);
    if (text !== null) {
      textParts.push(text);
      continue;
    }
    const url = readConnectorImageUrlPart(part);
    if (url !== null) imageUrls.push(url);
  }

  return { text: textParts.join("\n"), imageUrls };
}
