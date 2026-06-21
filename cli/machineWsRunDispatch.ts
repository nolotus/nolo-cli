import { runLocalAgentTurn, type LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { resolveLocalRuntimeEnvFromPolicy } from "../agent-runtime/runtimeToolPolicy";
import {
  assertMachineRunAllowed as defaultAssertMachineRunAllowed,
  resolveMachineRunPermissionPolicy as defaultResolveMachineRunPermissionPolicy,
} from "../ai/agent/machineRunPermissions";
import {
  collectConnectorRunArtifact as defaultCollectConnectorRunArtifact,
  readConnectorGitHead as defaultReadConnectorGitHead,
  resolveConnectorRunCwd as defaultResolveConnectorRunCwd,
} from "./connectorRunArtifact";
import { createCliLocalRuntimeAdapter } from "./client/localRuntimeAdapter";
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

/**
 * 从 connector payload 的 userInput 中提取 multimodal 内容。
 * 如果 userInput 是字符串，直接返回 { text, imageUrls: [] }。
 * 如果 userInput 是 multimodal content array（`[{ type: "text" }, { type: "image_url" }]`），
 * 提取 text 和 image_url parts。
 */
function extractMultimodalUserInput(userInput: unknown): {
  text: string;
  imageUrls: string[];
} {
  if (typeof userInput === "string") {
    return { text: userInput, imageUrls: [] };
  }
  if (!Array.isArray(userInput)) {
    return { text: String(userInput ?? ""), imageUrls: [] };
  }

  const textParts: string[] = [];
  const imageUrls: string[] = [];

  for (const part of userInput) {
    if (!part || typeof part !== "object") continue;
    if ((part as any).type === "text" && typeof (part as any).text === "string") {
      textParts.push((part as any).text);
    } else if (
      (part as any).type === "image_url" &&
      typeof (part as any).image_url?.url === "string" &&
      (part as any).image_url.url.trim()
    ) {
      imageUrls.push((part as any).image_url.url.trim());
    }
  }

  return { text: textParts.join("\n"), imageUrls };
}

type ConnectorRuntimePolicy = {
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

type ConnectorRunProgress = {
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

type PermissionPolicy = ReturnType<typeof defaultResolveMachineRunPermissionPolicy>;

type MachineWsRunDispatchDeps = {
  assertMachineRunAllowed?: typeof defaultAssertMachineRunAllowed;
  resolveMachineRunPermissionPolicy?: typeof defaultResolveMachineRunPermissionPolicy;
  resolveConnectorRunCwd?: typeof defaultResolveConnectorRunCwd;
  readConnectorGitHead?: typeof defaultReadConnectorGitHead;
  collectConnectorRunArtifact?: typeof defaultCollectConnectorRunArtifact;
  materializeLargeConnectorPrompt?: typeof defaultMaterializeLargeConnectorPrompt;
  readRuntimePromptPageMeta?: typeof defaultReadRuntimePromptPageMeta;
  buildConnectorCliPrompt?: (
    agentConfig: any,
    userInput: string,
    bridgeArgs: {
      agentKey: string;
      runtimeContext: any;
    },
    permissionPolicy?: PermissionPolicy
  ) => string;
  runConnectorLocalRuntimeAgent?: (args: {
    parsed: any;
    runtimeEnv: EnvLike;
    cwd: string;
    fetchImpl?: typeof fetch;
    onProgress?: (progress: ConnectorRunProgress) => void;
  }) => Promise<{
    content: string;
    model: string;
    trace?: unknown[];
    runtimeWorkspaceRoot?: string;
  }>;
};

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function logConnectorRun(message: string, fields: Record<string, unknown> = {}) {
  console.error(`[nolo-connector] ${message} ${JSON.stringify(fields)}`);
}

function summarizeRuntimePolicyForLogs(policy?: ConnectorRuntimePolicy) {
  return {
    hasPolicy: Boolean(policy),
    runtimeTools: policy?.runtimeTools ?? [],
    agentTools: policy?.agentTools ?? [],
    workspaceMode: policy?.workspace?.mode ?? null,
    workspaceCwd: policy?.workspace?.cwd ?? null,
    shellEnabled: policy?.shell?.enabled ?? null,
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

function summarizeAgentConfigForLogs(agentConfig: any) {
  const runtimeBinding = isRecord(agentConfig?.runtimeBinding) ? agentConfig.runtimeBinding : {};
  return {
    apiSource: agentConfig?.apiSource ?? null,
    provider: agentConfig?.provider ?? null,
    cliProvider: agentConfig?.cliProvider ?? null,
    model: agentConfig?.model ?? null,
    customProviderEndpoint: summarizeEndpoint(agentConfig?.customProviderUrl) ?? null,
    useServerProxy: agentConfig?.useServerProxy ?? null,
    skipLocalRuntimeEnsure: agentConfig?.skipLocalRuntimeEnsure ?? null,
    hasApiKey: typeof agentConfig?.apiKey === "string" && agentConfig.apiKey.length > 0,
    apiKeyHeader: agentConfig?.apiKeyHeader ?? null,
    hasApiKeyFromAgentKey:
      typeof agentConfig?.apiKeyFromAgentKey === "string" &&
      agentConfig.apiKeyFromAgentKey.length > 0,
    runtimeBindingKind: runtimeBinding.kind ?? null,
    runtimeMachineId: runtimeBinding.machineId ?? null,
    connectorSurface: runtimeBinding.connectorSurface ?? runtimeBinding.surface ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runtimePolicyFromConnectorPayload(parsed: any): ConnectorRuntimePolicy | undefined {
  const fromMeta = parsed?.payload?.meta?.runtimeToolPolicySnapshot;
  const fromAgent = parsed?.payload?.agentConfig?.runtimeToolPolicy;
  const policy = isRecord(fromMeta) ? fromMeta : isRecord(fromAgent) ? fromAgent : null;
  return policy ? policy as ConnectorRuntimePolicy : undefined;
}

function requestsLocalWorkspaceRuntime(policy?: ConnectorRuntimePolicy) {
  return Boolean(
    Array.isArray(policy?.runtimeTools) && policy.runtimeTools.length > 0,
  );
}

function isMachineBoundLocalCustomProvider(agentConfig: any) {
  const machineId =
    isRecord(agentConfig?.runtimeBinding) && typeof agentConfig.runtimeBinding.machineId === "string"
      ? agentConfig.runtimeBinding.machineId.trim()
      : "";
  const providerUrl =
    typeof agentConfig?.customProviderUrl === "string"
      ? agentConfig.customProviderUrl.trim()
      : "";
  if (!machineId || !providerUrl) return false;
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function hasExplicitMachinePermissions(agentConfig: any) {
  const runtimeBinding = isRecord(agentConfig?.runtimeBinding) ? agentConfig.runtimeBinding : {};
  return Boolean(
    isRecord(agentConfig?.machinePermissions) ||
      isRecord(runtimeBinding.permissions) ||
      isRecord(runtimeBinding.machinePermissions) ||
      isRecord(agentConfig?.boundRuntimeMachine?.permissions)
  );
}

function runtimeWorkspacePermissionPolicy(
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

function scopePermissionPolicyToRuntimeWorkspace(
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

function mergeToolNames(...values: unknown[]) {
  const names: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const name = typeof item === "string"
        ? item
        : isRecord(item) && typeof item.name === "string"
          ? item.name
          : isRecord(item) && typeof item.function?.name === "string"
            ? item.function.name
            : "";
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function localRuntimeEnvFromPolicy(runtimeEnv: EnvLike, policy?: ConnectorRuntimePolicy): EnvLike {
  return resolveLocalRuntimeEnvFromPolicy(runtimeEnv, policy);
}

function forwardedUserAuthToken(parsed: any): string {
  const value = parsed?.payload?.meta?.userAuthToken;
  return typeof value === "string" ? value.trim() : "";
}

function withForwardedUserAuthToken(runtimeEnv: EnvLike, parsed: any): EnvLike {
  const userAuthToken = forwardedUserAuthToken(parsed);
  return userAuthToken ? { ...runtimeEnv, AUTH_TOKEN: userAuthToken } : runtimeEnv;
}

function runtimeWorkspaceRootFromTrace(trace: unknown): string | undefined {
  if (!Array.isArray(trace)) return undefined;
  for (const message of trace) {
    if (!isRecord(message)) continue;
    const metadata = isRecord(message.tool_result_metadata)
      ? message.tool_result_metadata
      : null;
    const workspaceRoot = metadata && typeof metadata.workspaceRoot === "string"
      ? metadata.workspaceRoot.trim()
      : "";
    if (workspaceRoot) return workspaceRoot;
  }
  return undefined;
}

function buildArtifactProgress(args: {
  artifacts: unknown;
  runtimePolicy?: ConnectorRuntimePolicy;
  workspaceRoot: string;
  workspaceKind?: string;
}): ConnectorRunProgress | null {
  if (!isRecord(args.artifacts)) return null;
  const changedFiles = Array.isArray(args.artifacts.changedFiles)
    ? args.artifacts.changedFiles
    : [];
  const statusShort = typeof args.artifacts.statusShort === "string"
    ? args.artifacts.statusShort.trim()
    : "";
  if (changedFiles.length === 0 && !statusShort) return null;
  const runtimeTools = Array.isArray(args.runtimePolicy?.runtimeTools)
    ? args.runtimePolicy.runtimeTools
    : [];
  const shellTool = runtimeTools.includes("execShell")
    ? "execShell"
    : "workspaceArtifact";
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

async function defaultRunConnectorLocalRuntimeAgent(args: {
  parsed: any;
  runtimeEnv: EnvLike;
  cwd: string;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: ConnectorRunProgress) => void;
}): Promise<Awaited<ReturnType<typeof runLocalAgentTurn>> & { runtimeWorkspaceRoot?: string }> {
  const agentKey = String(args.parsed.payload?.agentKey ?? "");
  const payloadAgentConfig = isRecord(args.parsed.payload?.agentConfig)
    ? args.parsed.payload.agentConfig
    : {};
  const policy = runtimePolicyFromConnectorPayload(args.parsed);
  const agentRecord = {
    ...payloadAgentConfig,
    dbKey: agentKey,
    id: agentKey,
    key: agentKey,
    apiSource: payloadAgentConfig.apiSource ?? "platform",
    provider: payloadAgentConfig.provider ?? payloadAgentConfig.apiSource ?? "openai",
    toolNames: mergeToolNames(
      payloadAgentConfig.toolNames,
      payloadAgentConfig.tools,
      policy?.agentTools,
      policy?.runtimeTools,
    ),
    ...(policy ? { runtimeToolPolicy: policy } : {}),
  };
  const store = new Map<string, any>([
    [agentKey, agentRecord],
    [`agent-${args.runtimeEnv.NOLO_USER_ID || "local"}-${agentKey}`, agentRecord],
    [`agent-${args.runtimeEnv.NOLO_LOCAL_USER_ID || args.runtimeEnv.NOLO_USER_ID || "local"}-${agentKey}`, agentRecord],
  ]);
  const env = localRuntimeEnvFromPolicy(
    withForwardedUserAuthToken(args.runtimeEnv, args.parsed),
    policy
  );
  logConnectorRun("agent.run.local-runtime.env", {
    requestId: args.parsed.requestId,
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
  const result = await runLocalAgentTurn({
    adapter,
    agentRef: agentKey,
    input: String(args.parsed.payload?.userInput ?? ""),
    continueDialogId: typeof args.parsed.payload?.continueDialogId === "string"
      ? args.parsed.payload.continueDialogId
      : undefined,
    onToolEvent: (event) => {
      if (event.type === "tool-call") toolCallCount += 1;
      if (event.type === "tool-result") toolResultCount += 1;
      noteToolName(event.toolName);
      const metadata = isRecord(event.metadata) ? event.metadata : {};
      if (typeof metadata.workspaceRoot === "string" && metadata.workspaceRoot.trim()) {
        runtimeWorkspaceRoot = metadata.workspaceRoot.trim();
      }
      if (typeof metadata.workspaceKind === "string" && metadata.workspaceKind.trim()) {
        runtimeWorkspaceKind = metadata.workspaceKind.trim();
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

function normalizeConnectorRunTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export async function handleConnectorRunMessage(
  message: string,
  send: (message: string) => void,
  executeCli: LocalCliExecutor,
  runtimeEnv: EnvLike,
  fetchImpl?: typeof fetch,
  deps: MachineWsRunDispatchDeps = {},
) {
  let parsed: any;
  try {
    parsed = JSON.parse(message);
  } catch {
    return;
  }
  if (parsed?.type !== "agent.run" || typeof parsed.requestId !== "string") return;
  const agentConfig = parsed.payload?.agentConfig ?? {};
  const sendProgress = (progress: ConnectorRunProgress) => {
    send(JSON.stringify({
      type: "agent.run.progress",
      requestId: parsed.requestId,
      progress,
    }));
  };
  const buildConnectorCliPrompt = deps.buildConnectorCliPrompt;
  const resolveConnectorRunCwd = deps.resolveConnectorRunCwd ?? defaultResolveConnectorRunCwd;
  const resolveMachineRunPermissionPolicy =
    deps.resolveMachineRunPermissionPolicy ?? defaultResolveMachineRunPermissionPolicy;
  const assertMachineRunAllowed =
    deps.assertMachineRunAllowed ?? defaultAssertMachineRunAllowed;
  const readConnectorGitHead = deps.readConnectorGitHead ?? defaultReadConnectorGitHead;
  const collectConnectorRunArtifact =
    deps.collectConnectorRunArtifact ?? defaultCollectConnectorRunArtifact;
  const materializeLargeConnectorPrompt =
    deps.materializeLargeConnectorPrompt ?? defaultMaterializeLargeConnectorPrompt;
  const readRuntimePromptPageMeta =
    deps.readRuntimePromptPageMeta ?? defaultReadRuntimePromptPageMeta;
  const runConnectorLocalRuntimeAgent =
    deps.runConnectorLocalRuntimeAgent ?? defaultRunConnectorLocalRuntimeAgent;
  try {
    const machinePermissionPolicy = resolveMachineRunPermissionPolicy(agentConfig);
    const runtimePolicy = runtimePolicyFromConnectorPayload(parsed);
    const extractedInput = extractMultimodalUserInput(parsed.payload?.userInput);
    const userInput = extractedInput.text;
    const connectorImageUrls = extractedInput.imageUrls;
    const timeout = normalizeConnectorRunTimeoutMs(parsed.payload?.timeoutMs);
    let cwd = resolveConnectorRunCwd({ env: runtimeEnv, policy: machinePermissionPolicy });
    let runContent = "";
    let runModel = agentConfig.model;
    let runTrace: unknown[] = [];
    let artifactCwd = cwd;
    let baseSha: string | null = null;
    if (agentConfig.apiSource === "cli") {
      if (!buildConnectorCliPrompt) {
        throw new Error("buildConnectorCliPrompt is required for CLI connector runs.");
      }
      const runtimePermissionPolicy = !hasExplicitMachinePermissions(agentConfig)
        ? runtimeWorkspacePermissionPolicy(runtimePolicy, runtimeEnv, cwd)
        : null;
      const effectivePermissionPolicy = scopePermissionPolicyToRuntimeWorkspace(
        runtimePermissionPolicy ?? machinePermissionPolicy,
        runtimePolicy,
        cwd,
      );
      assertMachineRunAllowed(userInput, effectivePermissionPolicy);
      baseSha = await readConnectorGitHead(artifactCwd);
      const provider = String(agentConfig.cliProvider || agentConfig.provider || "copilot").trim() || "copilot";
      const builtPrompt = buildConnectorCliPrompt(agentConfig, userInput, {
        agentKey: String(parsed.payload?.agentKey ?? ""),
        runtimeContext: parsed.payload?.runtimeContext,
      }, effectivePermissionPolicy);
      const materializedPrompt = materializeLargeConnectorPrompt({
        prompt: builtPrompt,
        cwd,
        env: runtimeEnv,
        requestId: parsed.requestId,
        runtimePromptPage: readRuntimePromptPageMeta(parsed),
      });
      const runtimePromptPage = readRuntimePromptPageMeta(parsed);
      const startAt = Date.now();
      const progressBase = {
        provider,
        requestId: parsed.requestId,
        promptBytes: materializedPrompt.promptBytes,
        promptHash: materializedPrompt.promptHash,
        ...(materializedPrompt.promptRef ? { promptRef: materializedPrompt.promptRef } : {}),
        ...(runtimePromptPage?.dbKey ? { promptPageKey: runtimePromptPage.dbKey } : {}),
        ...(runtimePromptPage?.promptHash ? { promptPageHash: runtimePromptPage.promptHash } : {}),
        workspaceRoot: artifactCwd,
        workspaceKind: "current",
      };
      logConnectorRun("agent.run.cli.start", {
        requestId: parsed.requestId,
        agentKey: parsed.payload?.agentKey,
        provider,
        cwd,
        artifactCwd,
        timeout,
        promptBytes: materializedPrompt.promptBytes,
        promptHash: materializedPrompt.promptHash,
        promptRef: materializedPrompt.promptRef,
        promptPageKey: runtimePromptPage?.dbKey,
      });
      sendProgress({
        ...progressBase,
        message: "cli-started",
        updatedAt: startAt,
      });
      const heartbeat = setInterval(() => {
        sendProgress({
          ...progressBase,
        message: "cli-running",
          updatedAt: Date.now(),
        });
      }, 15_000);
      const effectiveRuntimeEnv = withForwardedUserAuthToken(runtimeEnv, parsed);
      const reasoningEffort =
        agentConfig.reasoning_effort || agentConfig.reasoningEffort || undefined;
      const result = await executeCli(provider, materializedPrompt.prompt, {
        model: agentConfig.model || undefined,
        timeout,
        cwd,
        yolo: true,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        env: {
          NOLO_SERVER:
            effectiveRuntimeEnv.NOLO_SERVER ||
            effectiveRuntimeEnv.NOLO_SERVER_URL ||
            effectiveRuntimeEnv.BASE_URL,
          NOLO_SERVER_URL:
            effectiveRuntimeEnv.NOLO_SERVER_URL ||
            effectiveRuntimeEnv.NOLO_SERVER ||
            effectiveRuntimeEnv.BASE_URL,
          BASE_URL:
            effectiveRuntimeEnv.BASE_URL ||
            effectiveRuntimeEnv.NOLO_SERVER ||
            effectiveRuntimeEnv.NOLO_SERVER_URL,
          AUTH_TOKEN:
            effectiveRuntimeEnv.AUTH_TOKEN ||
            effectiveRuntimeEnv.AUTH ||
            effectiveRuntimeEnv.NOLO_MACHINE_API_KEY,
          NOLO_MACHINE_API_KEY:
            effectiveRuntimeEnv.NOLO_MACHINE_API_KEY ||
            effectiveRuntimeEnv.AUTH_TOKEN ||
            effectiveRuntimeEnv.AUTH,
        },
        ...(connectorImageUrls.length > 0
          ? { imageInputs: connectorImageUrls.map((url) => ({ source: url })) }
          : {}),
      }).finally(() => clearInterval(heartbeat));
      logConnectorRun("agent.run.cli.result", {
        requestId: parsed.requestId,
        provider,
        elapsed: result.elapsed,
        outputBytes: byteLength(result.raw ?? result.text ?? ""),
      });
      runContent = result.text;
      runModel = String(agentConfig.model || "").trim() || provider;
      runTrace = [{ role: "assistant", content: result.text }];
      const artifacts = await collectConnectorRunArtifact({
        cwd: artifactCwd,
        baseSha,
        exitStatus: "completed",
      });
      const artifactProgress = buildArtifactProgress({
        artifacts,
        runtimePolicy,
        workspaceRoot: artifactCwd,
        workspaceKind: "current",
      });
      if (artifactProgress) sendProgress(artifactProgress);
      send(JSON.stringify({
        type: "agent.run.result",
        requestId: parsed.requestId,
        result: {
          content: runContent,
          model: runModel,
          trace: runTrace,
          artifacts,
        },
      }));
      return;
    }
    if (!requestsLocalWorkspaceRuntime(runtimePolicy) && !isMachineBoundLocalCustomProvider(agentConfig)) {
      throw new Error("Connector can only execute non-CLI agents when runtimeToolPolicySnapshot requests a local workspace runtime.");
    }
    logConnectorRun("agent.run.local-runtime.start", {
      requestId: parsed.requestId,
      agentKey: parsed.payload?.agentKey,
      cwd,
      timeout,
      machineBoundLocalCustomProvider: isMachineBoundLocalCustomProvider(agentConfig),
      runtimePolicy: Boolean(runtimePolicy),
      ...summarizeAgentConfigForLogs(agentConfig),
    });
    baseSha = await readConnectorGitHead(cwd);
    const result = await runConnectorLocalRuntimeAgent({
      parsed,
      runtimeEnv: withForwardedUserAuthToken(runtimeEnv, parsed),
      cwd,
      fetchImpl,
      onProgress: sendProgress,
    });
    runContent = result.content;
    runModel = result.model;
    runTrace = result.trace ?? [];
    artifactCwd = result.runtimeWorkspaceRoot ?? cwd;
    const artifacts = await collectConnectorRunArtifact({
      cwd: artifactCwd,
      baseSha,
      exitStatus: "completed",
    });
    const artifactProgress = buildArtifactProgress({
      artifacts,
      runtimePolicy,
      workspaceRoot: artifactCwd,
      workspaceKind: "current",
    });
    if (artifactProgress) sendProgress(artifactProgress);
    send(JSON.stringify({
      type: "agent.run.result",
      requestId: parsed.requestId,
      result: {
        content: runContent,
        model: runModel,
        trace: runTrace,
        artifacts,
      },
    }));
  } catch (error) {
    logConnectorRun("agent.run.error", {
      requestId: parsed.requestId,
      agentKey: parsed.payload?.agentKey,
      ...summarizeAgentConfigForLogs(agentConfig),
      errorName: error instanceof Error ? error.name : null,
      error: error instanceof Error ? error.message : String(error),
    });
    send(JSON.stringify({
      type: "agent.run.result",
      requestId: parsed.requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
