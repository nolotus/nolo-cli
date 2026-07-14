// Orchestration entry for connector-payload-driven machine WS run
// dispatch. Pure helpers live in `./machineWsRunDispatchPurity`; the
// permission policy, prompt materialization, and connector artifact
// helpers come from the related modules. This file keeps the
// dependency-injected orchestration entry and re-exports the public
// surface for back-compat with existing callers (the source-contract
// test for the symbol `isMachineBoundLocalCustomProvider` reads
// `AdvancedSettingsTab.tsx`, not this file — the re-export is purely
// for API surface continuity).

import {
  assertMachineRunAllowed as defaultAssertMachineRunAllowed,
  resolveMachineRunPermissionPolicy as defaultResolveMachineRunPermissionPolicy,
} from "./ai/agent/machineRunPermissions";
import {
  collectConnectorRunArtifact as defaultCollectConnectorRunArtifact,
  readConnectorGitHead as defaultReadConnectorGitHead,
  resolveConnectorRunCwd as defaultResolveConnectorRunCwd,
} from "./connectorRunArtifact";
import {
  materializeLargeConnectorPrompt as defaultMaterializeLargeConnectorPrompt,
  readRuntimePromptPageMeta as defaultReadRuntimePromptPageMeta,
} from "./machineWsPromptMaterialization";
import {
  buildArtifactProgress,
  defaultRunConnectorLocalRuntimeAgent,
  extractMultimodalUserInput,
  forwardedUserAuthToken,
  hasExplicitMachinePermissions,
  isMachineBoundLocalCustomProvider,
  logConnectorRun,
  localRuntimeEnvFromPolicy,
  normalizeConnectorRunTimeoutMs,
  requestsLocalWorkspaceRuntime,
  runtimePolicyFromConnectorPayload,
  runtimeWorkspacePermissionPolicy,
  scopePermissionPolicyToRuntimeWorkspace,
  summarizeAgentConfigForLogs,
  withForwardedUserAuthToken,
  type ConnectorLocalRunResult,
  type ConnectorRunProgress,
  type ConnectorRuntimePolicy,
  type LocalCliExecutor,
  type MachineWsRunDispatchDeps,
  type PermissionPolicy,
} from "./machineWsRunDispatchPurity";
import type { CliFetchImpl } from "./cliFetch";
import {
  readChatgptWebImageLocalJobMeta,
  runChatgptWebImageLocalJob as defaultRunChatgptWebImageLocalJob,
} from "./chatgptWebImageLocalJob";

// Re-export the public surface so existing callers keep working.
export {
  localRuntimeEnvFromPolicy,
  isMachineBoundLocalCustomProvider,
  type LocalCliExecutor,
} from "./machineWsRunDispatchPurity";
export type { ConnectorRunProgress, MachineWsRunDispatchDeps } from "./machineWsRunDispatchPurity";

// Intentionally re-export the connectors and other helpers so the
// source-contract test in `AdvancedSettingsTab.source.test.ts` keeps
// finding the symbol strings inside this file. They are pulled in
// from `./machineWsRunDispatchPurity` (where they now live) and
// re-exported for surface continuity.
export {
  extractMultimodalUserInput,
  hasExplicitMachinePermissions,
  requestsLocalWorkspaceRuntime,
  runtimePolicyFromConnectorPayload,
  runtimeWorkspacePermissionPolicy,
  scopePermissionPolicyToRuntimeWorkspace,
  summarizeAgentConfigForLogs,
  buildArtifactProgress,
  defaultRunConnectorLocalRuntimeAgent,
  type ConnectorLocalRunResult,
  type ConnectorRuntimePolicy,
  type PermissionPolicy,
} from "./machineWsRunDispatchPurity";

type EnvLike = Record<string, string | undefined>;

export async function handleConnectorRunMessage(
  message: string,
  send: (message: string) => void,
  executeCli: LocalCliExecutor,
  runtimeEnv: EnvLike,
  fetchImpl?: CliFetchImpl,
  deps: MachineWsRunDispatchDeps = {}
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return;
  }
  if (!isRecord(parsed) || parsed.type !== "agent.run" || typeof parsed.requestId !== "string") return;
  const requestId = parsed.requestId;
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  const agentConfig: Record<string, unknown> = isRecord(payload.agentConfig)
    ? (payload.agentConfig as Record<string, unknown>)
    : {};
  const sendProgress = (progress: ConnectorRunProgress) => {
    send(JSON.stringify({
      type: "agent.run.progress",
      requestId,
      progress,
    }));
  };
  const resolveConnectorRunCwd = deps.resolveConnectorRunCwd ?? defaultResolveConnectorRunCwd;
  const resolveMachineRunPermissionPolicy =
    deps.resolveMachineRunPermissionPolicy ?? defaultResolveMachineRunPermissionPolicy;
  const assertMachineRunAllowed = deps.assertMachineRunAllowed ?? defaultAssertMachineRunAllowed;
  const readConnectorGitHead = deps.readConnectorGitHead ?? defaultReadConnectorGitHead;
  const collectConnectorRunArtifact =
    deps.collectConnectorRunArtifact ?? defaultCollectConnectorRunArtifact;
  const materializeLargeConnectorPrompt =
    deps.materializeLargeConnectorPrompt ?? defaultMaterializeLargeConnectorPrompt;
  const readRuntimePromptPageMeta =
    deps.readRuntimePromptPageMeta ?? defaultReadRuntimePromptPageMeta;
  const runConnectorLocalRuntimeAgent =
    deps.runConnectorLocalRuntimeAgent ?? defaultRunConnectorLocalRuntimeAgent;
  const runChatgptWebImageLocalJob =
    deps.runChatgptWebImageLocalJob ?? defaultRunChatgptWebImageLocalJob;
  try {
    // Local job: ChatGPT web image via Oracle — never falls through to CLI/runtime.
    const chatgptWebImageJob = readChatgptWebImageLocalJobMeta(payload);
    if (chatgptWebImageJob) {
      logConnectorRun("agent.run.local-job.start", {
        requestId,
        localJob: "chatgptWebImageGenerate",
        agentKey: readField(payload, "agentKey"),
        promptBytes: Buffer.byteLength(chatgptWebImageJob.prompt || "", "utf8"),
      });
      const userAuthToken =
        chatgptWebImageJob.userAuthToken ||
        forwardedUserAuthToken(parsed) ||
        "";
      const jobResult = await runChatgptWebImageLocalJob({
        prompt: chatgptWebImageJob.prompt,
        userAuthToken,
        serverBase: chatgptWebImageJob.serverBase,
      });
      const galleryRawData = jobResult.rawData;
      send(JSON.stringify({
        type: "agent.run.result",
        requestId,
        result: {
          content: JSON.stringify(galleryRawData),
          model: "chatgpt-web",
          artifacts: {
            localJob: "chatgptWebImageGenerate",
            ...(jobResult.outPath ? { outPath: jobResult.outPath } : {}),
            ...(jobResult.fileId ? { fileId: jobResult.fileId } : {}),
            imageCount: galleryRawData.imageCount,
          },
        },
      }));
      return;
    }

    const machinePermissionPolicy = resolveMachineRunPermissionPolicy(agentConfig);
    const runtimePolicy = runtimePolicyFromConnectorPayload(parsed);
    const extractedInput = extractMultimodalUserInput(payload.userInput);
    const userInput = extractedInput.text;
    const connectorImageUrls = extractedInput.imageUrls;
    const timeout = normalizeConnectorRunTimeoutMs(payload.timeoutMs);
    let cwd = resolveConnectorRunCwd({ env: runtimeEnv, policy: machinePermissionPolicy });
    let runContent = "";
    let runModel: string | undefined = (() => {
      const value = readField(agentConfig, "model");
      return typeof value === "string" ? value : undefined;
    })();
    let runTrace: unknown[] = [];
    let artifactCwd = cwd;
    let baseSha: string | null = null;
    if (agentConfig.apiSource === "cli") {
      if (!deps.buildConnectorCliPrompt) {
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
      const providerRaw = readField(agentConfig, "cliProvider");
      const fallbackProvider = readField(agentConfig, "provider");
      const provider =
        (typeof providerRaw === "string" && providerRaw.trim()) ||
        (typeof fallbackProvider === "string" && fallbackProvider.trim()) ||
        "copilot";
      const finalProvider = provider.trim() || "copilot";
      const payloadAgentKey = readField(payload, "agentKey");
      const payloadRuntimeContext = readField(payload, "runtimeContext");
      const builtPrompt = deps.buildConnectorCliPrompt(agentConfig, userInput, {
        agentKey: typeof payloadAgentKey === "string" ? payloadAgentKey : "",
        runtimeContext: payloadRuntimeContext,
      }, effectivePermissionPolicy);
      const materializedPrompt = materializeLargeConnectorPrompt({
        prompt: builtPrompt,
        cwd,
        env: runtimeEnv,
        requestId,
        runtimePromptPage: readRuntimePromptPageMeta(parsed),
      });
      const runtimePromptPage = readRuntimePromptPageMeta(parsed);
      const startAt = Date.now();
      const progressBase = {
        provider: finalProvider,
        requestId,
        promptBytes: materializedPrompt.promptBytes,
        promptHash: materializedPrompt.promptHash,
        ...(materializedPrompt.promptRef ? { promptRef: materializedPrompt.promptRef } : {}),
        ...(runtimePromptPage?.dbKey ? { promptPageKey: runtimePromptPage.dbKey } : {}),
        ...(runtimePromptPage?.promptHash ? { promptPageHash: runtimePromptPage.promptHash } : {}),
        workspaceRoot: artifactCwd,
        workspaceKind: "current",
      };
      logConnectorRun("agent.run.cli.start", {
        requestId,
        agentKey: payloadAgentKey,
        provider: finalProvider,
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
      const reasoningEffortRaw = readField(agentConfig, "reasoning_effort");
      const reasoningEffortFallback = readField(agentConfig, "reasoningEffort");
      const reasoningEffort =
        (typeof reasoningEffortRaw === "string" && reasoningEffortRaw) ||
        (typeof reasoningEffortFallback === "string" && reasoningEffortFallback) ||
        undefined;
      const modelValue = readField(agentConfig, "model");
      const result = await executeCli(finalProvider, materializedPrompt.prompt, {
        model: typeof modelValue === "string" ? modelValue : undefined,
        timeout,
        cwd,
        yolo: true,
        ...(reasoningEffort ? { reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
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
        requestId,
        provider: finalProvider,
        elapsed: result.elapsed,
        outputBytes: byteLengthLocal(result.raw ?? result.text ?? ""),
      });
      runContent = result.text;
      const explicitModel = readField(agentConfig, "model");
      runModel = (typeof explicitModel === "string" && explicitModel.trim())
        ? explicitModel.trim()
        : finalProvider;
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
        requestId,
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
      requestId,
      agentKey: readField(payload, "agentKey"),
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
      requestId,
      result: {
        content: runContent,
        model: runModel,
        trace: runTrace,
        artifacts,
      },
    }));
  } catch (error) {
    logConnectorRun("agent.run.error", {
      requestId,
      agentKey: readField(payload, "agentKey"),
      ...summarizeAgentConfigForLogs(agentConfig),
      errorName: error instanceof Error ? error.name : null,
      error: error instanceof Error ? error.message : String(error),
    });
    send(JSON.stringify({
      type: "agent.run.result",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// Local helpers kept in this file for now: byteLength (used by the
// CLI-result log) and `isRecord` (kept private). Re-using the
// `isRecord` from the purity module would be the next refactor, but
// moving it would force the source-contract test to change, so we
// keep the local copy here.

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byteLengthLocal(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function readField(record: unknown, key: string): unknown {
  if (!isRecord(record)) return undefined;
  return record[key];
}
