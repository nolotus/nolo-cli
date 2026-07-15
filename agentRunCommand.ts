// Orchestration entry for `nolo agent run` and the related run/chat
// shorthands. Pure CLI arg parsing lives in `./agentRunArgs`; prompt
// construction helpers live in `./agentRunPrompts`; local workspace
// inspection helpers live in `./agentRunLocalWorkspace`. This file keeps
// the dependency-injected orchestration and re-exports the public surface
// for back-compat with existing callers.

import { runAgentTurn, type RunAgentTurnOptions, type RunAgentTurnResult } from "./client/agentRun";
import { CliProviderQuotaError } from "./ai/agent/cliExecutor";
import type { AgentRuntimeHostAdapter } from "./agentRuntimeLocal";
import { resolveAgentRecordFromHybridStore, readDbRecord } from "./agentRecordHelpers";
import { resolveAuthToken } from "./cliEnvHelpers";
import { homedir } from "node:os";
import { getReadableCliDb } from "./agentCommandSupport";
import { toErrorMessage } from "./core/errorMessage";
import { parsePositiveFiniteNumberOrFallback } from "./core/positiveFiniteNumberOrFallback";

import {
  buildLocalRunEnv,
  isLocalCliAgentKey,
  isFullstackCodingAgentRef,
  parseAgentRunArgs,
  readFlagValue,
  resolveRawAgentInput,
  resolveServerUrl,
  writeUsage,
  type ParseAgentRunArgsOptions,
  type ParsedAgentRunArgs,
} from "./agentRunArgs";
import {
  createRunActivityTracker,
  finalizeRunRecord,
  spawnLocalBackgroundRun,
  type AgentRunControlDeps,
} from "./agentRunControl";
import {
  normalizeCliImageInput,
  prependFeatureWorktreeInstruction,
  prependSubjectDialogMarker,
  prependWorkflowReferencePrompt,
  resolveWorkflowReference,
  type ResolvedWorkflowReference,
  resolveSkillReference,
  type ResolvedSkillReference,
  prependSkillReferencesPrompt,
} from "./agentRunPrompts";
import {
  formatLocalRunSummary,
  inspectLocalRunWorkspace,
  shouldPrintLocalRunSummary,
  type LocalRunWorkspaceInspection,
} from "./agentRunLocalWorkspace";

// Re-export the public surface so existing callers that import from
// `./agentRunCommand` keep working without changes.
export {
  parseAgentRunArgs,
  type ParsedAgentRunArgs,
  type ParseAgentRunArgsOptions,
} from "./agentRunArgs";
export {
  prependSubjectDialogMarker,
  resolveWorkflowReference,
  type ResolvedWorkflowReference,
} from "./agentRunPrompts";
export {
  inspectLocalRunWorkspace,
  type LocalRunWorkspaceInspection,
} from "./agentRunLocalWorkspace";
// `normalizeCliImageInput` is internal-only but kept exported here for
// back-compat with any external caller that pulled it from this file.
export { normalizeCliImageInput } from "./agentRunPrompts";

type EnvLike = Record<string, string | undefined>;

type OutputLike = {
  write(chunk: string): unknown;
};

export type AgentRunCommandDeps = {
  env?: EnvLike;
  scriptDir: string;
  output?: OutputLike;
  commandPath?: string[];
  cliEntrypointPath?: string;
  runner?: typeof runAgentTurn;
  localRuntimeAdapterFactory?: (env: EnvLike, options?: { cwd?: string }) => AgentRuntimeHostAdapter;
  inspectLocalRunWorkspace?: typeof inspectLocalRunWorkspace;
  resolveWorkflowReference?: typeof resolveWorkflowReference;
  resolveAgentRunAgentKey?: typeof resolveAgentRunAgentKey;
  spawnLocalBackgroundRun?: typeof spawnLocalBackgroundRun;
  finalizeRunRecord?: typeof finalizeRunRecord;
  /** Override for tests; defaults to `process.exit`. */
  processExit?: (code: number) => never;
  /** Override for tests; defaults to `NOLO_LOCAL_RUN_STALL_TIMEOUT_MS` env or 5 min. */
  stallTimeoutMs?: number;
} & Pick<AgentRunControlDeps, "homedir" | "spawn" | "fs" | "now" | "generateRunId">;

function resolvePositiveMs(value: unknown, fallback: number): number {
  return parsePositiveFiniteNumberOrFallback(value, fallback);
}

async function resolveAgentRunAgentKey(args: {
  agentInput: string;
  cliArgs: string[];
  env: EnvLike;
  output: OutputLike;
}) {
  if (!args.agentInput.trim() || args.agentInput.startsWith("agent-")) {
    return undefined;
  }
  const db = await getReadableCliDb(args.output);
  const resolved = await resolveAgentRecordFromHybridStore({
    agentInput: args.agentInput,
    cliArgs: args.cliArgs,
    env: args.env,
    db,
    fetchImpl: fetch,
  });
  return resolved?.agentKey;
}

export async function runAgentRunCommand(args: string[], deps: AgentRunCommandDeps) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (args.includes("--help") || args.includes("-h")) {
    writeUsage(output, deps.commandPath);
    return 0;
  }
  const parsed = parseAgentRunArgs(args, { commandPath: deps.commandPath });
  if (!parsed) {
    writeUsage(output, deps.commandPath);
    return 1;
  }

  const runner = deps.runner ?? runAgentTurn;

  // Watchdogs for local background child runs: an overall --timeout-ms and a
  // "no progress" stall timeout. They are only armed when this process is
  // responsible for a registry record (NOLO_AGENT_RUN_ID), so interactive
  // foreground runs are unaffected.
  const nowMs = () => (deps.now ? deps.now().getTime() : Date.now());
  const childRunId = env.NOLO_AGENT_RUN_ID;
  const hasRegistry = typeof childRunId === "string" && childRunId.length > 0;
  const processExit = deps.processExit ?? ((code: number) => process.exit(code));
  const stallTimeoutMs = resolvePositiveMs(
    deps.stallTimeoutMs ?? env.NOLO_LOCAL_RUN_STALL_TIMEOUT_MS,
    5 * 60_000,
  );
  let timedOut = false;
  let stalled = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  const activityTracker = hasRegistry
    ? createRunActivityTracker(childRunId, {
        env,
        homedir: deps.homedir,
        fs: deps.fs,
        now: deps.now,
      })
    : undefined;
  const clearWatchdogs = () => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (stallTimer !== undefined) clearInterval(stallTimer);
    activityTracker?.flush();
    activityTracker?.dispose();
  };
  // Watchdog failures also reject this deferred so the command promise settles
  // even when process.exit is stubbed (tests). In production process.exit
  // terminates first and the rejection is moot.
  let rejectOnWatchdogFailure: ((error: Error) => void) | undefined;
  const watchdogFailure: Promise<never> | undefined = hasRegistry
    ? new Promise<never>((_, reject) => {
        rejectOnWatchdogFailure = reject;
      })
    : undefined;
  const raceWithWatchdog = <T>(work: Promise<T>): Promise<T> =>
    watchdogFailure ? Promise.race([work, watchdogFailure]) : work;
  const exitFromWatchdog = (code: number) => {
    try {
      processExit(code);
    } catch {
      // Test stubs may throw instead of exiting; the watchdogFailure rejection
      // already carries the outcome, so swallow it here (a real process.exit
      // never returns).
    }
  };
  if (hasRegistry) {
    stallTimer = setInterval(() => {
      if (timedOut || stalled) return;
      const activity = activityTracker?.getActivity();
      const lastEventAtMs = activity
        ? new Date(activity.lastEventAt).getTime()
        : nowMs();
      const elapsedSinceEvent = nowMs() - lastEventAtMs;
      // Long-running tools (e.g. compilation) are allowed to exceed the stall
      // timeout; only declare a stall when nothing is in flight.
      if (activity?.inFlight?.kind === "tool") {
        return;
      }
      // An LLM request that hangs without completing is the stall scenario we
      // want to catch, even though it is technically "in flight".
      if (activity?.inFlight?.kind === "llm" && elapsedSinceEvent < stallTimeoutMs) {
        return;
      }
      if (elapsedSinceEvent >= stallTimeoutMs) {
        stalled = true;
        clearWatchdogs();
        const note = `stalled: no progress for ${stallTimeoutMs}ms`;
        output.write(`[nolo] local run ${note}\n`);
        (deps.finalizeRunRecord ?? finalizeRunRecord)(
          childRunId,
          { status: "failed", note },
          { env, homedir: deps.homedir, fs: deps.fs, now: deps.now },
        );
        rejectOnWatchdogFailure?.(new Error(`[nolo] local run ${note}`));
        exitFromWatchdog(1);
      }
    }, Math.min(stallTimeoutMs, 10_000));
    if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        clearWatchdogs();
        const note = `timed out after ${parsed.timeoutMs}ms`;
        output.write(`[nolo] local run ${note}\n`);
        (deps.finalizeRunRecord ?? finalizeRunRecord)(
          childRunId,
          { status: "timeout", note },
          { env, homedir: deps.homedir, fs: deps.fs, now: deps.now },
        );
        rejectOnWatchdogFailure?.(new Error(`[nolo] local run ${note}`));
        exitFromWatchdog(124);
      }, parsed.timeoutMs);
    }
  }

  // Support providing fallback suggestions for the orchestrating agent to decide.
  // No automatic switching here: the agent (via its prompt) decides if/which next to use
  // based on task, results, agent strengths, etc. This gives full control to the agent
  // for "下一个 下下个" sequencing.
  const wantsFallbackSuggestions = parsed.fallbackAgentKeys && parsed.fallbackAgentKeys.length > 0;
  const rawAgentInput = resolveRawAgentInput(args, deps.commandPath) ?? parsed.agentKey;
  const fullstackLocal = isFullstackCodingAgentRef(rawAgentInput, parsed.agentKey);
  const explicitLocalCli = isLocalCliAgentKey(parsed.agentKey);
  const isLocalRun = parsed.runtimeMode === "local" || (!parsed.runtimeMode && (fullstackLocal || explicitLocalCli || args.includes("--dangerously-allow-shell")));

  if (wantsFallbackSuggestions && !isLocalRun) {
    output.write("[nolo] --fallback-agent (suggestions) is only supported for local CLI runs (use --local)\n");
    return 1;
  }

  // If fallbacks suggested, augment the message so the agent sees the options and is instructed to decide.
  let effectiveMessage = parsed.message;
  if (wantsFallbackSuggestions) {
    effectiveMessage = `${parsed.message}\n\n[Quota fallback context for agent decision: If this execution for ${parsed.agentKey} hits subscription quota, YOU (the agent) must decide the next agent to use. Do not rely on automatic wrapper. Reason based on the specific task (complexity, length, domain), agent strengths, cost, previous attempt results. Suggested alternatives: ${parsed.fallbackAgentKeys!.join(', ')}. Update the task row with attempt history and dispatch the chosen next (via new agent run or startAgentDialog).]`;
  }

  // Resolve handle/name -> agent key for any run that may reach the server
  // (default/auto/server). Only an explicit local CLI run skips this, since the
  // local adapter resolves its own way. Without this, a bare handle like
  // "agy-pro" is sent to the server verbatim and 404s.
  const resolvedAgentKey =
    parsed.runtimeMode !== "local"
      ? await (deps.resolveAgentRunAgentKey ?? resolveAgentRunAgentKey)({
          agentInput: resolveRawAgentInput(args, deps.commandPath) ?? parsed.agentKey,
          cliArgs: args,
          env,
          output,
        }).catch(() => undefined)
      : undefined;
  const agentKey = resolvedAgentKey ?? parsed.agentKey;
  let workflowReference: ResolvedWorkflowReference | undefined;
  if (parsed.workflowRef) {
    try {
      workflowReference = await (deps.resolveWorkflowReference ?? resolveWorkflowReference)(
        parsed.workflowRef
      );
    } catch (error) {
      output.write(`[nolo] ${toErrorMessage(error)}\n`);
      return 1;
    }
  }

  let skillReferences: ResolvedSkillReference[] | undefined;
  if (parsed.skillRefs?.length) {
    const skills: ResolvedSkillReference[] = [];
    const authToken = resolveAuthToken(args, env);
    const serverUrl = resolveServerUrl(env);
    for (const ref of parsed.skillRefs) {
      try {
        const resolved = await resolveSkillReference(ref, {
          cwd: parsed.cwd,
          readDbRecord: async (dbKey: string) => {
            return readDbRecord({
              dbKey,
              authToken,
              serverUrl,
              fetchImpl: fetch,
            });
          },
        });
        skills.push(resolved);
      } catch (error) {
        output.write(`[nolo] ${toErrorMessage(error)}\n`);
        return 1;
      }
    }
    skillReferences = skills;
  }
  let localRuntimeCwd = parsed.cwd;
  if (!localRuntimeCwd && parsed.runtimeMode === "local") {
    localRuntimeCwd = homedir();
  }
  const runEnv = buildLocalRunEnv({
    env,
    allowShell: parsed.allowShell,
  });

  // Local background runs: detach a child process, write a registry record,
  // and return immediately. The child re-invokes this same CLI without --bg
  // and finalizes the registry record on exit.
  if (parsed.background && isLocalRun) {
    const { runId, pid, logPath } = await (deps.spawnLocalBackgroundRun ?? spawnLocalBackgroundRun)(
      {
        rawArgs: args,
        commandPath: deps.commandPath,
        cliEntrypointPath: deps.cliEntrypointPath,
        agentKey,
        cwd: parsed.cwd,
        msgFile: readFlagValue(args, "--msg-file"),
        timeoutMs: parsed.timeoutMs,
        output,
      },
      {
        env,
        homedir: deps.homedir,
        spawn: deps.spawn,
        fs: deps.fs,
        now: deps.now,
        generateRunId: deps.generateRunId,
      }
    );
    output.write(`[nolo] runId=${runId}\n`);
    output.write(`[nolo] pid=${pid ?? "-"}\n`);
    output.write(`[nolo] log=${logPath}\n`);
    output.write(`[nolo] status: nolo agent status ${runId}\n`);
    output.write(`[nolo] stop: nolo agent stop ${runId}\n`);
    return 0;
  }

  // Build the runner options once; the same options (message, cwd,
  // subjectRefs, runtime mode, etc.) are reused for any quota fallback retry
  // so the fallback agent executes against an identical request surface.
  const buildRunOptions = (targetAgentKey: string): RunAgentTurnOptions => ({
    agentName: targetAgentKey,
    agentKey: targetAgentKey,
    serverUrl: resolveServerUrl(env),
    message: prependSkillReferencesPrompt(
      prependWorkflowReferencePrompt(
        prependSubjectDialogMarker(
          prependFeatureWorktreeInstruction(
            effectiveMessage,
            parsed.injectFeatureWorktreeInstruction
          ),
          parsed.subjectDialogKey
        ),
        workflowReference
      ),
      skillReferences
    ),
    imageUrls: parsed.imageUrls.map(normalizeCliImageInput),
    scriptDir: deps.scriptDir,
    env: runEnv,
    output,
    ...(deps.localRuntimeAdapterFactory
      ? { localRuntimeAdapterFactory: deps.localRuntimeAdapterFactory }
      : {}),
    ...(localRuntimeCwd ? { localRuntimeCwd } : {}),
    ...(parsed.runtimeMode ? { runtimeMode: parsed.runtimeMode } : {}),
    ...(parsed.continueDialogId ? { continueDialogId: parsed.continueDialogId } : {}),
    ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}),
    ...(parsed.category ? { category: parsed.category } : {}),
    ...(parsed.inheritedFromDialogKey ? { inheritedFromDialogKey: parsed.inheritedFromDialogKey } : {}),
    ...(parsed.parentDialogId ? { parentDialogId: parsed.parentDialogId } : {}),
    ...(parsed.parentWakeOnTerminal ? { parentWakeOnTerminal: true } : {}),
    ...(parsed.subjectDialogKey ? { subjectDialogKey: parsed.subjectDialogKey } : {}),
    ...(parsed.subjectRefs?.length ? { subjectRefs: parsed.subjectRefs } : {}),
    ...(parsed.allowedChildAgentKeys?.length ? { allowedChildAgentKeys: parsed.allowedChildAgentKeys } : {}),
    ...(parsed.allowedToolNames?.length ? { allowedToolNames: parsed.allowedToolNames } : {}),
    ...(activityTracker ? { onLoopEvent: activityTracker.onLoopEvent } : {}),
    background: parsed.background,
    noStream: parsed.noStream,
    ...(typeof parsed.timeoutMs === "number" ? { timeoutMs: parsed.timeoutMs } : {}),
    traceTools: parsed.traceTools,
    ...(parsed.eventsMode ? { eventsMode: parsed.eventsMode } : {}),
    ...(parsed.taskEvidence ? { taskEvidence: parsed.taskEvidence } : {}),
  });

  let result: RunAgentTurnResult = await raceWithWatchdog(runner(buildRunOptions(agentKey)));
  clearWatchdogs();

  // Quota auto-fallback: when a run fails because the provider reports a
  // quota/limit (HTTP 429 or CliProviderQuotaError, or an error message that
  // mentions quota/额度/上限), and the command line supplied --fallback-agent,
  // retry the SAME request exactly once with the first fallback agent. This
  // is a run-level switch only; it does not touch server-side scheduling.
  if (result.exitCode !== 0 && isQuotaExhaustedError(result.localError) && isLocalRun && parsed.fallbackAgentKeys && parsed.fallbackAgentKeys.length > 0) {
    const fallbackAgentKey = parsed.fallbackAgentKeys[0];
    output.write(
      `[nolo] quota exhausted on ${agentKey}, falling back to ${fallbackAgentKey}\n`
    );
    const fallbackResult: RunAgentTurnResult = await raceWithWatchdog(runner(buildRunOptions(fallbackAgentKey)));
    clearWatchdogs();
    if (fallbackResult.exitCode === 0) {
      result = fallbackResult;
    } else {
      // Fallback also failed: report the fallback failure normally and keep
      // the fallback's error for downstream surfacing.
      result = fallbackResult;
      output.write(
        `[nolo] fallback to ${fallbackAgentKey} also failed: ${
          fallbackResult.localError instanceof Error
            ? fallbackResult.localError.message
            : String(fallbackResult.localError ?? "unknown error")
        }\n`
      );
    }
  } else if (result.localError instanceof CliProviderQuotaError) {
    // Surface quota error clearly when no automatic fallback is available
    // (no --fallback-agent given, or run was not local). The agent still gets
    // the prompt-level suggestions for self-dispatch.
    output.write(`\n[nolo] Quota limit hit for ${parsed.agentKey} (CliProviderQuotaError).\n`);
    if (parsed.fallbackAgentKeys && parsed.fallbackAgentKeys.length > 0) {
      output.write(`Suggested alternatives for your decision: ${parsed.fallbackAgentKeys.join(', ')}\n`);
    }
    output.write(`As the orchestrating agent, decide next based on task and re-dispatch (update task state with this attempt).\n`);
  }

  if (result.dialogId) {
    if (parsed.background) {
      output.write(`\n[nolo] background dialog ${result.dialogId}\n`);
      output.write(`[nolo] read: nolo dialog read ${result.dialogId}\n`);
    } else {
      output.write(`\n[nolo] dialog ${result.dialogId}\n`);
    }
  }
  if (shouldPrintLocalRunSummary({ parsed, localRuntimeCwd })) {
    try {
      const inspect = deps.inspectLocalRunWorkspace ?? inspectLocalRunWorkspace;
      const inspection = await inspect(localRuntimeCwd!);
      output.write(formatLocalRunSummary({
        dialogId: result.dialogId,
        inspection,
      }));
    } catch (error) {
      output.write(
        `\n[nolo] local run summary unavailable: ${toErrorMessage(error)}\n`
      );
    }
  }

  // If this process was spawned as a local background child, finalize the
  // registry record so the parent `nolo agent ps/status` sees the outcome.
  if (typeof childRunId === "string" && childRunId.length > 0) {
    const finalStatus = result.exitCode === 0 ? "done" : "failed";
    await (deps.finalizeRunRecord ?? finalizeRunRecord)(childRunId, {
      status: finalStatus,
      exitCode: result.exitCode,
      dialogId: result.dialogId,
    },
    {
      env,
      homedir: deps.homedir,
      fs: deps.fs,
      now: deps.now,
    });
  }

  return result.exitCode;
}

// Detect quota/limit exhaustion from a run error. Covers the structured
// CliProviderQuotaError (local CLI providers), raw HTTP 429 responses, and
// provider error messages that mention quota/额度/上限/rate limit keywords.
const QUOTA_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /429/,
  /quota/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /额度/,
  /上限/,
  /用尽/,
  /CliProviderQuotaError/i,
];

function isQuotaExhaustedError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof CliProviderQuotaError) return true;
  if (error instanceof Error) {
    return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
  }
  if (typeof error === "string") {
    return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(error));
  }
  // Some adapter errors carry an HTTP status code directly on the object.
  const maybeStatus = (error as { status?: unknown }).status;
  if (typeof maybeStatus === "number" && maybeStatus === 429) return true;
  const maybeStatusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof maybeStatusCode === "number" && maybeStatusCode === 429) return true;
  return false;
}
