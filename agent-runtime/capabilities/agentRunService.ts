import type { CapabilityExecutionContext } from "./capability";
import type { AgentRuntimeToolResult } from "../hostAdapter";
import type {
  AgentActivityEvent,
  AgentRunActivity,
} from "./agentRunActivity";

export interface AgentRunStartOptions {
  agentId?: string;
  agentKey?: string;
  task: string;
  input?: unknown;
  agentName?: string;
  ephemeral?: boolean;
  batchId?: string;
  parentDialogId?: string;
  parentActivityId?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface AgentRunStartResult {
  runId: string;
  status?: string;
  agentKey?: string;
  agentName?: string;
  batchId?: string;
  taskPreview?: string;
  content?: string;
}

export interface AgentRunWaitOptions {
  runId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface AgentRunWaitResult {
  runId: string;
  status: string;
  content?: string;
  errorMessage?: string;
  durationMs?: number;
  raw?: unknown;
}

export interface AgentRunCancelOptions {
  runId: string;
  signal?: AbortSignal;
}

export interface AgentRunCancelResult {
  runId: string;
  status: string;
  wasActive?: boolean;
}

export interface AgentRunInspectOptions {
  runId: string;
  tailLines?: number;
}

export interface AgentRunInspectResult {
  runId: string;
  found: boolean;
  status?: string;
  agentName?: string;
  lastAssistantText?: string;
  errorMessage?: string;
  logLines?: string[];
  startedAt?: number;
  finishedAt?: number;
}

export interface AgentRunService {
  start(
    options: AgentRunStartOptions,
    ctx?: CapabilityExecutionContext,
  ): Promise<AgentRunStartResult>;
  wait(
    options: AgentRunWaitOptions,
    ctx?: CapabilityExecutionContext,
  ): Promise<AgentRunWaitResult>;
  cancel?(
    options: AgentRunCancelOptions,
    ctx?: CapabilityExecutionContext,
  ): Promise<AgentRunCancelResult>;
  inspect?(
    options: AgentRunInspectOptions,
    ctx?: CapabilityExecutionContext,
  ): Promise<AgentRunInspectResult>;
}

export interface AgentRunInput {
  agentId?: string;
  agentKey?: string;
  task: string;
  input?: unknown;
  agentName?: string;
  timeoutMs?: number;
  ephemeral?: boolean;
  batchId?: string;
  resultMode?: "full" | "summary";
  signal?: AbortSignal;
  parentActivityId?: string;
}

export interface AgentRunResult {
  runId: string;
  status: "completed" | "cancelled" | "timeout" | string;
  content: string;
  activityId: string;
  durationMs?: number;
  error?: string;
  raw?: unknown;
}

let activityCounter = 0;
export function generateActivityId(prefix = "act"): string {
  activityCounter = (activityCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${activityCounter}`;
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const activeSignals = signals.filter((s): s is AbortSignal => Boolean(s));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(activeSignals);
  }
  const controller = new AbortController();
  for (const s of activeSignals) {
    if (s.aborted) {
      controller.abort((s as any).reason);
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort((s as any).reason), { once: true });
  }
  return controller.signal;
}

export async function executeAgentRunLifecycle(
  service: AgentRunService,
  input: AgentRunInput,
  ctx: CapabilityExecutionContext = {},
): Promise<AgentRunResult> {
  const agentKey = input.agentKey ?? input.agentId;
  if (!agentKey || typeof agentKey !== "string" || !agentKey.trim()) {
    throw new Error("agents.run: 缺少有效的 agentId 或 agentKey。");
  }
  if (!input.task || typeof input.task !== "string" || !input.task.trim()) {
    throw new Error("agents.run: 缺少有效的 task 文本描述。");
  }

  const effectiveSignal = combineSignals([input.signal, ctx.abortSignal]);
  if (effectiveSignal?.aborted) {
    const abortErr = new Error("Agent run was aborted before starting");
    abortErr.name = "AbortError";
    throw abortErr;
  }

  const activityId = generateActivityId("act-run");
  const parentActivityId =
    input.parentActivityId ??
    ctx.activityContext?.parentActivityId ??
    (ctx as any).parentActivityId;

  const startedAt = Date.now();

  const activity: AgentRunActivity = {
    activityId,
    ...(parentActivityId ? { parentActivityId } : {}),
    kind: "agent-run",
    agentId: agentKey,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    task: input.task,
    status: "starting",
    startedAt,
  };

  const emit = async (type: AgentActivityEvent["type"]) => {
    if (ctx.onActivity) {
      try {
        await ctx.onActivity({
          type,
          activity: { ...activity },
        });
      } catch {
        // Activity sink errors must not swallow or alter core execution errors
      }
    }
  };

  // 1. Activity: starting
  await emit("activity-started");

  let startResult: AgentRunStartResult;
  try {
    startResult = await service.start(
      {
        agentId: agentKey,
        agentKey,
        task: input.task,
        input: input.input,
        agentName: input.agentName,
        ephemeral: input.ephemeral,
        batchId: input.batchId,
        parentActivityId,
        signal: effectiveSignal,
      },
      ctx,
    );
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    const finishedAt = Date.now();
    activity.status = "failed";
    activity.finishedAt = finishedAt;
    activity.durationMs = finishedAt - startedAt;
    activity.error = errorMsg;
    await emit("activity-finished");
    throw err;
  }

  const runId = startResult.runId;
  activity.runId = runId;

  // Check if start completed synchronously
  if (startResult.status === "done" || startResult.status === "completed") {
    const finishedAt = Date.now();
    activity.status = "completed";
    activity.finishedAt = finishedAt;
    activity.durationMs = finishedAt - startedAt;
    activity.result = startResult.content;
    await emit("activity-finished");
    return {
      runId,
      status: "completed",
      content: startResult.content ?? "",
      activityId,
      durationMs: activity.durationMs,
    };
  }

  if (startResult.status === "failed") {
    const finishedAt = Date.now();
    activity.status = "failed";
    activity.finishedAt = finishedAt;
    activity.durationMs = finishedAt - startedAt;
    activity.error = "Agent run start failed";
    await emit("activity-finished");
    throw new Error(`Agent run ${runId} failed on start.`);
  }

  // 2. Activity: running
  activity.status = "running";
  await emit("activity-updated");

  // Wire automatic cancellation on signal abort during wait
  let abortCleanup: (() => void) | undefined;
  if (effectiveSignal && service.cancel) {
    const onAbort = () => {
      service.cancel?.({ runId, signal: effectiveSignal }, ctx).catch(() => {});
    };
    if (effectiveSignal.aborted) {
      onAbort();
    } else {
      effectiveSignal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => effectiveSignal.removeEventListener("abort", onAbort);
    }
  }

  // 3. Wait for completion
  let waitResult: AgentRunWaitResult;
  try {
    waitResult = await service.wait(
      {
        runId,
        timeoutMs: input.timeoutMs ?? (ctx.agentRunTimeoutMs as number | undefined),
        signal: effectiveSignal,
      },
      ctx,
    );
  } catch (err: any) {
    abortCleanup?.();
    const errorMsg = err?.message || String(err);
    const finishedAt = Date.now();
    activity.status = effectiveSignal?.aborted ? "cancelled" : "failed";
    activity.finishedAt = finishedAt;
    activity.durationMs = finishedAt - startedAt;
    activity.error = errorMsg;
    await emit("activity-finished");
    throw err;
  } finally {
    abortCleanup?.();
  }

  const finishedAt = Date.now();
  activity.finishedAt = finishedAt;
  activity.durationMs = finishedAt - startedAt;

  if (waitResult.status === "done" || waitResult.status === "completed") {
    activity.status = "completed";
    activity.result = waitResult.content;
    await emit("activity-finished");
    return {
      runId,
      status: "completed",
      content: waitResult.content ?? "",
      activityId,
      durationMs: activity.durationMs,
      raw: waitResult.raw,
    };
  }

  if (waitResult.status === "cancelled" || waitResult.status === "killed" || effectiveSignal?.aborted) {
    activity.status = "cancelled";
    await emit("activity-finished");
    return {
      runId,
      status: "cancelled",
      content: waitResult.content ?? "",
      activityId,
      durationMs: activity.durationMs,
      raw: waitResult.raw,
    };
  }

  if (waitResult.status === "timeout") {
    activity.status = "failed"; // Activity status maps to failed with explicit error
    activity.error = "Agent run timed out";
    // Attempt best-effort cancellation of timed out run
    if (service.cancel) {
      service.cancel({ runId }, ctx).catch(() => {});
    }
    await emit("activity-finished");
    return {
      runId,
      status: "timeout",
      content: waitResult.content ?? "",
      activityId,
      durationMs: activity.durationMs,
      error: "Agent run timed out",
      raw: waitResult.raw,
    };
  }

  activity.status = "failed";
  activity.error = waitResult.errorMessage ?? `Agent run finished with status "${waitResult.status}"`;
  await emit("activity-finished");
  throw new Error(activity.error);
}

export function createToolBridgeAgentRunService(options: {
  startRunner: (args: AgentRunStartOptions) => Promise<{ rawData: any; displayData: string }>;
  waitRunner: (args: AgentRunWaitOptions) => Promise<{ rawData: any; displayData: string }>;
  cancelRunner?: (args: { runId: string }) => Promise<{ rawData: any; displayData: string }>;
  inspectRunner?: (args: { runId: string; tailLines?: number }) => Promise<{ rawData: any; displayData: string }>;
}): AgentRunService {
  return {
    start: async (opts) => {
      const res = await options.startRunner(opts);
      const raw = res.rawData;
      if (typeof raw === "string") {
        return {
          runId: generateActivityId("sync-run"),
          status: "done",
          content: raw,
        };
      }
      return {
        runId: raw?.runId ?? generateActivityId("run"),
        status: raw?.status ?? "pending",
        agentKey: raw?.agentKey,
        agentName: raw?.agentName,
        batchId: raw?.batchId,
        taskPreview: raw?.taskPreview,
        content: raw?.content,
      };
    },
    wait: async (opts) => {
      const res = await options.waitRunner(opts);
      const raw = res.rawData;
      return {
        runId: raw?.runId ?? opts.runId,
        status: raw?.status ?? "done",
        content: typeof raw === "string" ? raw : (raw?.content ?? res.displayData),
        errorMessage: raw?.errorMessage ?? raw?.error,
        raw,
      };
    },
    cancel: options.cancelRunner
      ? async (opts) => {
          const res = await options.cancelRunner!({ runId: opts.runId });
          return {
            runId: res.rawData?.runId ?? opts.runId,
            status: res.rawData?.status ?? "cancelled",
            wasActive: res.rawData?.wasActive,
          };
        }
      : undefined,
    inspect: options.inspectRunner
      ? async (opts) => {
          const res = await options.inspectRunner!({ runId: opts.runId, tailLines: opts.tailLines });
          return {
            runId: res.rawData?.runId ?? opts.runId,
            found: res.rawData?.found ?? true,
            status: res.rawData?.status,
            logLines: res.rawData?.logLines,
          };
        }
      : undefined,
  };
}

/**
 * Host-tool AgentRunService — wires `tools.agents.run()` through the SAME
 * `executeTool` seam the host uses for model tool calls.
 *
 * The host supplies its own tool-execution boundary (`hostExecuteTool`), which
 * for CLI/desktop local is `AgentRuntimeHostAdapter.executeTool` and for server
 * is a thin wrapper over `executeToolOnServer`. Because the bridge calls that
 * same boundary for `startAgentRun` / `controlAgentRun`, the SDK path inherits
 * the host's real executors, authority (allowedChildAgentKeys), tool policy,
 * transport, and run/dialog persistence — no second polling / persistence /
 * authority layer, and no per-host AgentRunService variant.
 *
 * The host boundary returns `AgentRuntimeToolResult = { content, metadata }`
 * (same shape model tools return); we do minimal canonical parsing: try
 * JSON.parse(content) → rawData, fall back to the raw string, and surface
 * `metadata.displayData` for the TUI renderers.
 */
export interface HostExecuteToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type HostExecuteTool = (
  call: HostExecuteToolCall,
  opts?: { abortSignal?: AbortSignal },
) => Promise<AgentRuntimeToolResult>;

let toolCallSeq = 0;

export function createHostToolAgentRunService(
  hostExecuteTool: HostExecuteTool,
): AgentRunService {
  const execTool = async (
    name: string,
    args: Record<string, unknown>,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<{ rawData: any; displayData: string }> => {
    // Host boundaries expect the agent-tool-call shape (id included); synth a
    // stable-enough id so agentRuntimeHostAdapter.executeTool works verbatim.
    const id = `sdk-${Date.now().toString(36)}-${(++toolCallSeq).toString(36)}`;
    const res = await hostExecuteTool({ id, name, arguments: JSON.stringify(args) }, opts);
    let rawData: any = res.content;
    if (typeof res.content === "string" && res.content.length) {
      try {
        rawData = JSON.parse(res.content);
      } catch {
        rawData = res.content;
      }
    }
    // Surface host tool-expression errors: some host boundaries (e.g. server
    // executeToolOnServer) report a refusal as { error } content rather than
    // throwing. Treat that as a rejection so authority/policy denials reach the
    // SDK caller instead of being swallowed as a "successful" run.
    if (
      rawData &&
      typeof rawData === "object" &&
      typeof (rawData as any).error === "string"
    ) {
      throw new Error((rawData as any).error);
    }
    return {
      rawData,
      displayData:
        typeof res.metadata?.displayData === "string"
          ? res.metadata.displayData
          : String(res.content ?? ""),
    };
  };

  return createToolBridgeAgentRunService({
    startRunner: async (opts) =>
      execTool("startAgentRun", {
        agentKey: opts.agentKey ?? opts.agentId,
        task: opts.task,
        input: opts.input,
        agentName: opts.agentName,
        ephemeral: opts.ephemeral,
        batchId: opts.batchId,
        parentDialogId: opts.parentDialogId,
        wait: false,
      }),
    waitRunner: async (opts) =>
      execTool(
        "controlAgentRun",
        {
          action: "wait",
          runId: opts.runId,
          timeoutMs: opts.timeoutMs,
        },
        // Forward the per-run abort signal so the host wait loop can be
        // cancelled (CLI controlAgentRun wait reads opts.abortSignal).
        { abortSignal: opts.signal },
      ),
    cancelRunner: async ({ runId }) =>
      execTool("controlAgentRun", { action: "stop", runId }),
    inspectRunner: async ({ runId, tailLines }) =>
      execTool("controlAgentRun", {
        action: "status",
        runId,
        tailLines: tailLines ?? 0,
      }),
  });
}
