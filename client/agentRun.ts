import {
  LOCAL_AGENT_CONFIG_MISSING_CODE,
  LOCAL_TURN_ABORTED_CODE,
} from "../agent-runtime/localLoop";
import { resolveAgentRuntimeConfigFromRecord } from "../agent-runtime/agentRecordConfig";
import {
  applyModelLayerOverride,
  type ModelLayerOverride,
} from "../agent-runtime/modelLayerOverride";
import type { AgentRuntimeHostAdapter } from "../agentRuntimeLocal";
import {
  createCliCallAgentToolExecutor,
  createCliLocalRuntimeAdapter,
  ensureDialogSyncedForServerFallback,
  isBuiltinNoloAgentRef,
} from "./localRuntimeAdapter";
import type {
  LocalAgentTurnInput,
  LocalAgentTurnResult,
} from "../agent-runtime/localLoop";
import { buildTurnTokenUsage, formatUsage, shouldShowUsage } from "./tokenUsage";

import {
  createCliTurnOutput,
  formatAssistantResponseForCli,
} from "./agentRunOutput";
import { readStreamingAgentRun } from "./agentRunStream";

import {
  type DispatchPlan,
  resolveAuthToken,
  isMachineBoundLocalhostCustomProvider,
  resolveBoundMachineId,
  detectCurrentMachineId,
  isCliProviderAgentConfig,
  type AgentRunSubjectRef,
  type RunAgentTurnOptions,
  type RunAgentTurnResult,
} from "./agentRunTypes";
import { Spinner } from "./agentRunSpinner";
import {
  resolveServerPlatformToolNames,
  isKnownServerPlatformAgent,
} from "./agentRunPlatformTools";
import { isGatewayHttpStatus } from "../core/gatewayHttpStatus";

import { ulid } from "ulid";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedString } from "../core/trimmedString";
import { toErrorMessage } from "../core/errorMessage";

/** Local loop is heavy; load only when a local turn actually runs. */
async function loadRunLocalAgentTurn() {
  const { runLocalAgentTurn } = await import("../agentRuntimeLocal");
  return runLocalAgentTurn;
}

type ReviewDecisionStatus = "passed" | "needs_changes" | "blocked";

async function resolveCurrentMachineId(options: RunAgentTurnOptions) {
  return options.currentMachineIdResolver
    ? options.currentMachineIdResolver(options.env)
    : detectCurrentMachineId(options.env);
}

function resolveRequestedRuntimeMode(options: RunAgentTurnOptions) {
  const envMode = options.env.NOLO_RUNTIME_MODE;
  if (options.runtimeMode) return options.runtimeMode;
  if (envMode === "local" || envMode === "server" || envMode === "auto")
    return envMode;
  return "auto";
}

function buildDefaultLocalRuntimeAdapter(options: RunAgentTurnOptions) {
  return createCliLocalRuntimeAdapter({
    env: options.env,
    fetchImpl: options.fetchImpl,
    cwd: options.localRuntimeCwd,
    output: options.output,
    ...(options.confirmDestructiveAction
      ? { confirmDestructiveAction: options.confirmDestructiveAction }
      : {}),
    ...(options.requestUserChoice
      ? { requestUserChoice: options.requestUserChoice }
      : {}),
  });
}

function resolveLocalRuntimeAdapter(options: RunAgentTurnOptions) {
  return (
    options.localRuntimeAdapter ||
    options.localRuntimeAdapterFactory?.(options.env, {
      cwd: options.localRuntimeCwd,
    }) ||
    buildDefaultLocalRuntimeAdapter(options)
  );
}

/**
 * Ephemeral / memory-only adapter wrapper. Replaces `saveTurn` with an
 * in-memory no-op (returns the turn's dialogId without writing to any store
 * or syncing to a remote server) and `loadDialogHistory` with an empty
 * history (ephemeral dialogs are never persisted, so they have no history to
 * load). Capabilities are intentionally left untouched — persistence
 * *capability* is descriptive host metadata consumed by runtime decision
 * logic (runtimeFacts/runtimeDecision); ephemeral changes *behavior* on
 * this turn, not the host's capability set. Everything else (agent config,
 * provider, tools) is unchanged so a liveness probe still exercises the real
 * runtime path — only persistence is stripped out.
 */
function wrapAdapterEphemeral(
  adapter: AgentRuntimeHostAdapter,
): AgentRuntimeHostAdapter {
  return {
    ...adapter,
    loadDialogHistory: async () => [],
    saveTurn: async (input) => ({
      dialogId: input.continueDialogId ?? "ephemeral",
    }),
  };
}

function applyEphemeralIfRequested(
  options: RunAgentTurnOptions,
  adapter: AgentRuntimeHostAdapter,
): AgentRuntimeHostAdapter {
  return options.ephemeral ? wrapAdapterEphemeral(adapter) : adapter;
}

/**
 * quick-chat 自动路由的 model 层覆盖（local 模式）：tier agent 的配置从
 * adapter 读出后，用覆盖包替换其 model 层再交给 local loop；
 * 其余 agentRef 透传，不影响 callAgent 子代理。
 */
function wrapLoadAgentConfigWithModelOverride(
  adapter: AgentRuntimeHostAdapter,
  targetAgentKey: string,
  override: ModelLayerOverride,
): AgentRuntimeHostAdapter {
  return {
    ...adapter,
    loadAgentConfig: async (agentRef: string) => {
      const config = await adapter.loadAgentConfig(agentRef);
      if (!config || agentRef !== targetAgentKey) return config;
      const baseRecord =
        (config as { rawRecord?: Record<string, unknown> }).rawRecord ??
        (config as unknown as Record<string, unknown>);
      return resolveAgentRuntimeConfigFromRecord(
        agentRef,
        applyModelLayerOverride(baseRecord, override),
      );
    },
  };
}

async function shouldSkipAutoLocalForServerPlatformTools(
  options: RunAgentTurnOptions,
) {
  if (isBuiltinNoloAgentRef(options.agentKey)) return false;
  if (options.localRuntimeCwd) {
    return false;
  }
  const knownServerPlatformAgent = isKnownServerPlatformAgent(options);
  const adapter = resolveLocalRuntimeAdapter(options);
  if (!adapter) return knownServerPlatformAgent;
  let agentConfig;
  try {
    agentConfig = await adapter.loadAgentConfig(options.agentKey);
  } catch {
    if (knownServerPlatformAgent) {
      options.output.write(
        `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is a known platform agent. ` +
          "Use --local explicitly to force local workspace tools.\n",
      );
      return true;
    }
    return false;
  }
  if (isCliProviderAgentConfig(agentConfig)) {
    const boundMachineId = resolveBoundMachineId(agentConfig);
    if (!boundMachineId) return false;
    const currentMachineId =
      (await resolveCurrentMachineId(options))?.trim() || "";
    if (currentMachineId && currentMachineId === boundMachineId) return false;
    options.output.write(
      `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is bound to ${boundMachineId}` +
        (currentMachineId ? ` and this machine is ${currentMachineId}.` : ".") +
        " Use --local explicitly to force the current machine.\n",
    );
    return true;
  }
  if (knownServerPlatformAgent) {
    options.output.write(
      `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is a known platform agent. ` +
        "Use --local explicitly to force local workspace tools.\n",
    );
    return true;
  }
  if (isMachineBoundLocalhostCustomProvider(agentConfig)) {
    options.output.write(
      `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is a machine-bound localhost custom provider. ` +
        "Use --local explicitly to force the current machine.\n",
    );
    return true;
  }
  const serverTools = resolveServerPlatformToolNames(agentConfig);
  if (serverTools.length === 0) return false;
  options.output.write(
    `[nolo] auto runtime: skipping local runtime because ${options.agentKey} declares server platform tools ` +
      `(${serverTools.join(", ")}). Use --local explicitly to force local workspace tools.\n`,
  );
  return true;
}

function buildUserInputContent(message: string, imageUrls: string[] = []) {
  if (imageUrls.length === 0) return message;
  return [
    ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
    ...imageUrls.map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
  ];
}

function buildSubjectRefs(options: RunAgentTurnOptions) {
  const refs: AgentRunSubjectRef[] = [];
  const seen = new Set<string>();
  const pushRef = (ref: AgentRunSubjectRef) => {
    const kind = ref.kind.trim();
    const id = ref.id.trim();
    const role = ref.role?.trim();
    if (!kind || !id) return;
    const key = `${kind}\u0000${id}\u0000${role ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, id, ...(role ? { role } : {}) });
  };
  for (const ref of options.subjectRefs ?? []) pushRef(ref);
  if (options.subjectDialogKey) {
    pushRef({
      kind: "dialog",
      id: options.subjectDialogKey,
      role: "subject",
    });
  }
  if (options.taskEvidence?.rowDbKey) {
    pushRef({
      kind: "table-row",
      id: options.taskEvidence.rowDbKey,
      role: "task",
    });
  }
  for (const artifactId of options.taskEvidence?.artifactIds ?? []) {
    pushRef({
      kind: "artifact",
      id: artifactId,
      role: "evidence",
    });
  }
  return refs.length ? refs : undefined;
}

function isMissingLocalAgentConfigError(error: unknown, agentRef: string) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string; agentRef?: string }).code ===
      LOCAL_AGENT_CONFIG_MISSING_CODE &&
    (error as { code?: string; agentRef?: string }).agentRef === agentRef,
  );
}

function shouldAttemptAutoLocal(options: RunAgentTurnOptions) {
  if (options.localRuntimeAdapter || options.localRuntimeAdapterFactory)
    return true;
  if (
    options.env.NOLO_DISABLE_CLI_WORKSPACE_TOOLS !== "1" &&
    isBuiltinNoloAgentRef(options.agentKey) &&
    resolveAuthToken(options.env)
  ) {
    return true;
  }
  if (
    options.env.NOLO_DISABLE_CLI_WORKSPACE_TOOLS !== "1" &&
    resolveAuthToken(options.env) &&
    !isKnownServerPlatformAgent(options)
  ) {
    return true;
  }
  return Boolean(
    options.env.NOLO_LOCAL_OPENAI_API_KEY ||
    options.env.OPENAI_API_KEY ||
    options.env.NOLO_LOCAL_OPENAI_BASE_URL ||
    options.env.OPENAI_BASE_URL ||
    options.env.NOLO_LOCAL_AGENT_KEY,
  );
}

export function classifyReviewDecisionStatus(
  summary?: string,
): ReviewDecisionStatus | undefined {
  const normalized = summary?.toLowerCase().trim();
  if (!normalized) return undefined;

  const explicit = normalized.match(
    /review\s+decision\s*:\s*(passed|needs_changes|blocked)/,
  );
  if (explicit?.[1]) return explicit[1] as ReviewDecisionStatus;

  if (
    /\b(blocked|cannot review|unable to review)\b|无法审查|阻塞/.test(
      normalized,
    )
  ) {
    return "blocked";
  }
  if (
    /\b(needs changes|request changes|changes requested|not approved)\b|需要修改|需修改|发现问题/.test(
      normalized,
    )
  ) {
    return "needs_changes";
  }
  if (/\b(approved|lgtm|no issues|passed)\b|通过|无问题/.test(normalized)) {
    return "passed";
  }
  return undefined;
}

function buildTransportErrorHint(serverUrl: string, error: unknown) {
  const endpoint = `${serverUrl}/api/agent/run`;
  const reason = toErrorMessage(error);

  let detail = `[nolo] Could not reach ${endpoint}.\n` + `Reason: ${reason}\n`;

  try {
    const parsed = new URL(serverUrl);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      detail +=
        "If you meant local dev, start the local API first.\n" +
        "Otherwise set NOLO_SERVER to a reachable server, or re-run `nolo login --server https://nolo.chat`.\n";
      return detail;
    }
  } catch {
    // Keep the generic hint below when serverUrl is not a valid absolute URL.
  }

  detail +=
    "Check NOLO_SERVER / BASE_URL and make sure the configured server is reachable.\n";
  return detail;
}

async function readAgentRunFailureMetadata(
  res: Response,
): Promise<{ dialogId?: string }> {
  const data = await res
    .clone()
    .json()
    .catch(() => ({}));
  return {
    ...(asOptionalTrimmedString(data?.dialogId)
      ? { dialogId: asOptionalTrimmedString(data?.dialogId) }
      : {}),
  };
}

async function runHttpAgentTurn(
  options: RunAgentTurnOptions,
  authToken: string,
) {
  const spinner = new Spinner(
    options.output,
    `${options.agentName} -> working`,
    // 与 createCliTurnOutput 的兜底构造一致：传入 activityReporter 时
    // Spinner 静默，避免 TUI docked 活动行与 spinner 帧重复 live 指示。
    Boolean(options.activityReporter),
  );
  spinner.start();

  const fetchImpl = options.fetchImpl ?? fetch;
  const subjectRefs = buildSubjectRefs(options);
  const allowedChildAgentKeys = options.allowedChildAgentKeys?.filter((key) =>
    key.trim(),
  );
  const allowedToolNames = options.allowedToolNames?.filter((name) =>
    name.trim(),
  );
  const blockedToolNames = options.blockedToolNames?.filter((name) =>
    name.trim(),
  );
  const shouldStream = !options.noStream && !options.background;
  const buildRequestBody = (stream: boolean) =>
    JSON.stringify({
      agentKey: options.agentKey,
      userInput: buildUserInputContent(
        options.extraContextBlocks?.length
          ? [...options.extraContextBlocks, "", options.message].join("\n")
          : options.message,
        options.imageUrls,
      ),
      runtimeContext: {
        surface: "cli",
        host: "terminal",
        runtime: "bun",
        entrypoint: "nolo-cli",
        capabilities: ["text-io", "streaming", "slash-commands"],
        ...(subjectRefs ? { subjectRefs } : {}),
        ...(allowedChildAgentKeys?.length ? { allowedChildAgentKeys } : {}),
        ...(blockedToolNames?.length ? { blockedToolNames } : {}),
        ...(allowedToolNames?.length ? { allowedToolNames } : {}),
      },
      ...(options.continueDialogId
        ? { continueDialogId: options.continueDialogId }
        : {}),
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.inheritedFromDialogKey
        ? { inheritedFromDialogKey: options.inheritedFromDialogKey }
        : {}),
      ...(options.parentDialogId
        ? { parentDialogId: options.parentDialogId }
        : {}),
      ...(options.background ? { background: true } : {}),
      ...(typeof options.timeoutMs === "number"
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.modelOverride
        ? { runtimeOptions: { quickChatModelOverride: options.modelOverride } }
        : {}),
      stream,
    });
  const postAgentRun = (stream: boolean) =>
    fetchImpl(`${options.serverUrl}/api/agent/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: buildRequestBody(stream),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
  let res: Response;
  try {
    res = await postAgentRun(shouldStream);
  } catch (error) {
    spinner.stop();
    if (options.abortSignal?.aborted) {
      return { exitCode: 0, streamInterrupted: true };
    }
    options.output.write(buildTransportErrorHint(options.serverUrl, error));
    return { exitCode: 1 };
  }

  if (shouldStream && isGatewayHttpStatus(res.status)) {
    const failureMeta = await readAgentRunFailureMetadata(res);
    if (!failureMeta.dialogId) {
      spinner.stop();
      options.output.write(
        `[nolo] streaming request returned HTTP ${res.status}; retrying once without streaming.\n`,
      );
      spinner.start();
      try {
        res = await postAgentRun(false);
      } catch (error) {
        spinner.stop();
        options.output.write(buildTransportErrorHint(options.serverUrl, error));
        return { exitCode: 1 };
      }
    }
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") && res.body) {
    const result = await readStreamingAgentRun(options, res, spinner);
    return result;
  }

  spinner.stop();
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    options.output.write(`[nolo] Agent request failed: HTTP ${res.status}\n`);
    const errorText = asTrimmedString(data?.error);
    const messageText = asTrimmedString(data?.message);
    const reasonText = asTrimmedString(data?.reason);
    const codeText = asTrimmedString(data?.code);
    const dialogIdText = asTrimmedString(data?.dialogId);
    if (errorText || messageText) {
      options.output.write(`${errorText || messageText}\n`);
      if (messageText && messageText !== errorText) {
        options.output.write(`${messageText}\n`);
      }
      if (codeText && codeText !== errorText && codeText !== messageText) {
        options.output.write(`code=${codeText}\n`);
      }
      if (
        reasonText &&
        reasonText !== errorText &&
        reasonText !== messageText
      ) {
        options.output.write(`reason=${reasonText}\n`);
      }
    }
    if (dialogIdText) {
      options.output.write(`[nolo] failed dialog: ${dialogIdText}\n`);
      options.output.write(
        `[nolo] continue with: nolo agent run ${options.agentKey} --continue ${dialogIdText} --msg "retry"\n`,
      );
    }
    return dialogIdText
      ? { exitCode: 1, dialogId: dialogIdText }
      : { exitCode: 1 };
  }

  const content = formatAssistantResponseForCli(
    String(data?.content ?? data?.message ?? ""),
    options,
  );
  if (content) {
    options.output.write(`\n${options.agentName} > ${content}\n`);
  } else {
    options.output.write(`\n${options.agentName} > (no text response)\n`);
  }

  const usage = formatUsage(data?.usage, data?.dialogId);
  if (usage && shouldShowUsage(options.env)) options.output.write(`${usage}\n`);
  return {
    exitCode: 0,
    ...(typeof data?.dialogId === "string" && data.dialogId
      ? { dialogId: data.dialogId }
      : {}),
    turnTokens: buildTurnTokenUsage(
      data?.usage,
      typeof data?.model === "string" ? data.model : options.agentKey,
    ),
  };
}

async function runInjectedLocalAgentTurn(options: RunAgentTurnOptions) {
  return runLocalAgentTurnForCli(options, { reportFailure: true });
}

async function refreshMissingLocalAgentConfig(options: RunAgentTurnOptions) {
  const adapter = resolveLocalRuntimeAdapter(options);
  if (!adapter) return false;
  const agentConfig = await adapter.loadAgentConfig(options.agentKey);
  return Boolean(agentConfig);
}

async function runLocalAgentTurnForCli(
  options: RunAgentTurnOptions,
  settings: { reportFailure: boolean },
) {
  const resolvedBaseAdapter = resolveLocalRuntimeAdapter(options);
  const baseAdapter = (() => {
    let adapter =
      resolvedBaseAdapter && options.modelOverride
        ? wrapLoadAgentConfigWithModelOverride(
            resolvedBaseAdapter,
            options.agentKey,
            options.modelOverride,
          )
        : resolvedBaseAdapter;
    if (adapter) adapter = applyEphemeralIfRequested(options, adapter);
    return adapter;
  })();
  if (!baseAdapter) {
    options.output.write(
      "[nolo] Local runtime was requested but no local runtime adapter is available.\n",
    );
    return { exitCode: 1 };
  }

  const subjectRefs = buildSubjectRefs(options);
  const allowedChildAgentKeys = options.allowedChildAgentKeys?.filter((key) =>
    key.trim(),
  );
  const allowedToolNames = options.allowedToolNames?.filter((name) =>
    name.trim(),
  );
  const blockedToolNames = options.blockedToolNames?.filter((name) =>
    name.trim(),
  );
  const runtimeContext: Record<string, any> | undefined =
    subjectRefs ||
    allowedChildAgentKeys?.length ||
    allowedToolNames?.length ||
    blockedToolNames?.length ||
    options.parentWakeOnTerminal
      ? {
          ...(subjectRefs ? { subjectRefs } : {}),
          ...(allowedChildAgentKeys?.length ? { allowedChildAgentKeys } : {}),
          ...(allowedToolNames?.length ? { allowedToolNames } : {}),
          ...(blockedToolNames?.length ? { blockedToolNames } : {}),
          ...(options.parentWakeOnTerminal
            ? { parentWakeOnTerminal: true }
            : {}),
          ...(options.parentDialogId
            ? { parentThreadId: options.parentDialogId }
            : {}),
        }
      : undefined;
  const currentDialogId = options.continueDialogId ?? ulid();

  const runChildTurn = async (
    input: LocalAgentTurnInput,
  ): Promise<LocalAgentTurnResult> => {
    const { runLocalAgentTurn } = await import("../agentRuntimeLocal");
    return runLocalAgentTurn(input);
  };

  const createFreshChildBaseAdapter = () => {
    const fresh =
      options.localRuntimeAdapterFactory?.(options.env, {
        cwd: options.localRuntimeCwd,
      }) ?? buildDefaultLocalRuntimeAdapter(options);
    return applyEphemeralIfRequested(options, fresh);
  };

  const withLocalDelegation = (args: {
    base: AgentRuntimeHostAdapter;
    dialogId: string;
    spaceId?: string;
    runtimeContext?: Record<string, any>;
  }): AgentRuntimeHostAdapter => {
    let adapter: AgentRuntimeHostAdapter;
    const callAgentExecutor = createCliCallAgentToolExecutor(
      {
        env: options.env,
        fetchImpl: options.fetchImpl,
        cwd: options.localRuntimeCwd,
        output: options.output,
      },
      {
        createChildAdapter: (child) =>
          withLocalDelegation({
            base: createFreshChildBaseAdapter(),
            dialogId: child.dialogId,
            spaceId: child.spaceId,
            runtimeContext: child.runtimeContext,
          }),
        runChildTurn,
        dialogId: args.dialogId,
        spaceId: args.spaceId,
        runtimeContext: args.runtimeContext,
      },
    );
    adapter = {
      ...args.base,
      executeTool: async (call) => {
        if (call.name === "callAgent") {
          return callAgentExecutor(call);
        }
        return args.base.executeTool(call);
      },
    };
    return adapter;
  };
  const adapter = withLocalDelegation({
    base: baseAdapter,
    dialogId: currentDialogId,
    spaceId: options.spaceId,
    runtimeContext,
  });

  const workingLabel = `${options.agentName} -> working locally`;
  const turnOutput = createCliTurnOutput({
    options,
    workingLabel,
  });
  turnOutput.spinner.start();
  try {
    const runLocalAgentTurn = await loadRunLocalAgentTurn();
    const result = await runLocalAgentTurn({
      adapter,
      agentRef: options.agentKey,
      input: buildUserInputContent(options.message, options.imageUrls),
      continueDialogId: currentDialogId,
      spaceId: options.spaceId,
      category: options.category,
      inheritedFromDialogKey: options.inheritedFromDialogKey,
      parentDialogId: options.parentDialogId,
      background: options.background,
      noStream: options.noStream,
      ...(runtimeContext ? { runtimeContext } : {}),
      ...(options.extraContextBlocks?.length
        ? { contextBlocks: options.extraContextBlocks }
        : {}),
      ...(typeof options.timeoutMs === "number"
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.actionGateHandler
        ? { onActionGate: options.actionGateHandler }
        : {}),
      onLoopEvent: (event) => {
        if (event.kind === "llm-start") {
          turnOutput.showWorking();
        }
        if (event.kind === "image-downgraded") {
          // 第 4 级降级提示：模型不支持图片，已用占位文本替代；给用户 escape hatch。
          // 不阻断当前轮——agent 拿到的是 [Image content omitted...] 占位文本，能继续跑。
          options.output.write(
            "[nolo] 当前 agent 不支持图片输入，已用占位文本替代。要完整图片理解可 /switch 到 Kimi K2.6。\n",
          );
        }
        options.onLoopEvent?.(event);
      },
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(turnOutput.traceLocalTools
        ? {
            onToolEvent: (event) => {
              turnOutput.handleToolEvent(event);
            },
          }
        : {}),
      ...(!options.noStream
        ? {
            onTextDelta: (chunk) => {
              turnOutput.pushText(chunk);
            },
          }
        : {}),
    });
    turnOutput.finish(result.content);
    return {
      exitCode: 0,
      dialogId: result.dialogId,
      turnTokens: buildTurnTokenUsage(result.usage, result.model),
    };
  } catch (error) {
    turnOutput.spinner.stop();
    if (
      (error as { code?: string })?.code === LOCAL_TURN_ABORTED_CODE ||
      options.abortSignal?.aborted
    ) {
      // User-initiated stop: the TUI reports it; nothing failed.
      return { exitCode: 0, streamInterrupted: true };
    }
    if (settings.reportFailure) {
      options.output.write(
        `[nolo] Local agent run failed: ${toErrorMessage(error)}\n`,
      );
    }
    return { exitCode: 1, localError: error };
  }
}

export async function runAgentTurn(options: RunAgentTurnOptions) {
  const authToken = resolveAuthToken(options.env);
  const runtimeMode = resolveRequestedRuntimeMode(options);

  if (runtimeMode === "local") {
    return runInjectedLocalAgentTurn(options);
  }

  if (runtimeMode === "auto" && shouldAttemptAutoLocal(options)) {
    const skipLocal = await shouldSkipAutoLocalForServerPlatformTools(options);
    if (!skipLocal) {
      const localResult = await runLocalAgentTurnForCli(options, {
        reportFailure: false,
      });
      if (localResult.exitCode === 0) {
        return {
          exitCode: localResult.exitCode,
          ...(localResult.dialogId ? { dialogId: localResult.dialogId } : {}),
          ...(localResult.turnTokens
            ? { turnTokens: localResult.turnTokens }
            : {}),
        };
      }
      if (
        isMissingLocalAgentConfigError(localResult.localError, options.agentKey)
      ) {
        // Local config refresh is local-adapter only; still prefer local before any server path.
        options.output.write(
          `[nolo] Local agent config was missing; refreshing local config and retrying local once.\n`,
        );
        try {
          const refreshed = await refreshMissingLocalAgentConfig(options);
          if (refreshed) {
            const retriedLocalResult = await runLocalAgentTurnForCli(options, {
              reportFailure: false,
            });
            if (retriedLocalResult.exitCode === 0) {
              return {
                exitCode: retriedLocalResult.exitCode,
                ...(retriedLocalResult.dialogId
                  ? { dialogId: retriedLocalResult.dialogId }
                  : {}),
                ...(retriedLocalResult.turnTokens
                  ? { turnTokens: retriedLocalResult.turnTokens }
                  : {}),
              };
            }
          }
        } catch {
          // Fall through — server fallback only when authenticated (M3).
        }
      }
      // M3: no server fallback without an auth token. Surface local failure instead.
      if (!authToken) {
        const localErrorMessage = localResult.localError
          ? toErrorMessage(localResult.localError)
          : "local runtime failed";
        options.output.write(
          `[nolo] auto runtime: local run unavailable (${localErrorMessage}). ` +
            "No auth token is set, so server fallback is disabled. " +
            "Fix local credentials/config, or run `nolo login` / set AUTH_TOKEN to enable server runtime.\n",
        );
        return {
          exitCode: 1,
          ...(localResult.dialogId ? { dialogId: localResult.dialogId } : {}),
        };
      }
      if (localResult.localError) {
        options.output.write(
          `[nolo] auto runtime: local run unavailable (${toErrorMessage(localResult.localError)}); falling back to server.\n`,
        );
      }
      const syncResult = await ensureDialogSyncedForServerFallback(
        options,
        authToken,
      );
      if (!syncResult.ok) {
        return { exitCode: syncResult.exitCode ?? 1 };
      }
    }
  }

  if (!authToken) {
    options.output.write(
      "[nolo] This install needs an auth token before it can talk to agents.\n" +
        "Run `nolo login`, or set AUTH_TOKEN / NOLO_SERVER for non-interactive runs.\n",
    );
    return { exitCode: 1 };
  }

  // Reaching the HTTP/server path means the run will be persisted by the
  // server. --ephemeral/--memory-only only suppresses *local* persistence, so
  // warn whether the user asked for --server explicitly or auto fell back here.
  if (options.ephemeral) {
    options.output.write(
      "[nolo] --ephemeral/--memory-only is only effective with the local runtime (--local); the server stores dialogs on its own and cannot run memory-only.\n",
    );
  }

  return runHttpAgentTurn(options, authToken);
}
