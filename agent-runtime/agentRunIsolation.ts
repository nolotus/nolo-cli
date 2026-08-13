/**
 * Agent run isolation — subtask vs interactive run-kind discrimination and
 * tool/context filtering.
 *
 * Background
 * ----------
 * `startAgentRun` dispatches subtask agent runs that were historically treated
 * identically to interactive dialog runs: they received the full project
 * context stack (AGENTS.md + skill-discovery + memory-overlay + dialog-summary
 * + space-context + user-global-prompt) AND the orchestration tool surface
 * (startAgentRun/controlAgentRun/listAgents/readAgent/...).
 *
 * User-confirmed contract:
 *  1. Orchestration tools are only for interactive agents, never for subtasks.
 *  2. Subtasks default to ZERO project context — all context comes from the
 *     caller's `task` / `input` payload.
 *  3. Subtasks keep read-only git tools but lose git write tools
 *     (gitAdd/gitCommit/gitCreateBranch/commitWorkspace).
 *  4. Defense in depth: run-layer filtering (code) + config-layer trimming
 *     (platform config, documented separately).
 *
 * runKind signal
 * --------------
 * CLI child-process dispatch (`agentRunControl.spawnLocalBackgroundRun`) sets
 * `NOLO_AGENT_RUN_CHILD=1` on the spawned env. Interactive `nolo agent run`
 * invoked from the TUI/foreground has no such env. This module centralizes the
 * detection so every runtime surface (localLoop tool resolution, context-block
 * assembly, server-side TODO hook) reads the same signal.
 *
 * Server path: there is no spawned child env, so subtask discrimination on the
 * server must come from `runtimeContext`. The config-layer trimming note in
 * this file's companion doc describes how platform config supplies that signal
 * via the existing `runtimeContext.allowedToolNames` / `blockedToolNames`
 * mechanism plus a future `runtimeContext.runKind` field.
 */

/** Env-like record — minimal shape so this module is reusable across hosts. */
export type RunIsolationEnvLike = Record<string, string | undefined>;

/**
 * Orchestration tool names — interactive-only. A subtask must never see these
 * because it would let a dispatched agent recursively dispatch more agents
 * (unbounded fan-out) or introspect other agents' configs.
 *
 * `agent-orchestration` capability pack contributes the first three; the rest
 * are agent-related tools that either dispatch (startAgentRun, runStreamingAgent,
 * startAgentDialog, streamParallelAgents) or introspect (readAgent, listAgents).
 */
export const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "startAgentRun",
  "controlAgentRun",
  "listAgents",
  "readAgent",
  "startAgentDialog",
  "runStreamingAgent",
  "streamParallelAgents",
]);

/**
 * Git write tool names removed for subtasks. Read-only git inspection (gitStatus,
 * gitDiff) is retained so a subtask can verify repo state, but mutating git
 * (add/commit/create-branch/commitWorkspace) is the interactive agent's job —
 * the subtask should only produce diffs and let the orchestrator commit.
 *
 * Mirrors `REMOVED_WORKSPACE_TOOL_NAMES` in localWorkspaceToolDefs.ts; kept
 * here as an explicit list so the isolation module is the single source of
 * truth for what a subtask loses.
 */
export const SUBTASK_REMOVED_GIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "gitAdd",
  "gitCommit",
  "gitCreateBranch",
  "commitWorkspace",
]);

/** All tool names a subtask must NOT receive (orchestration + git write). */
export const SUBTASK_REMOVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...ORCHESTRATION_TOOL_NAMES,
  ...SUBTASK_REMOVED_GIT_TOOL_NAMES,
]);

/**
 * Detect whether the current process is a dispatched subtask agent run.
 *
 * `NOLO_AGENT_RUN_CHILD=1` is set by `agentRunControl.spawnLocalBackgroundRun`
 * on every CLI child-process dispatch. Interactive foreground `nolo agent run`
 * does not set it. Any truthy non-empty string counts (defensive: a stray
 * "0" or empty value means "not a child").
 *
 * Server path has no spawned child; server-side subtask detection must come
 * from `runtimeContext` (TODO — see config-layer trimming note).
 */
export function isSubtaskRun(env: RunIsolationEnvLike | undefined): boolean {
  if (!env) return false;
  const value = env.NOLO_AGENT_RUN_CHILD;
  return typeof value === "string" && value.length > 0 && value !== "0";
}

/**
 * Filter a tool-name list for the resolved run kind.
 *
 * - Interactive runs (`isSubtask=false`): returned unchanged — zero behavior
 *   change for the existing interactive path.
 * - Subtask runs: orchestration tools + git write tools removed. The remaining
 *   "干活" tools (readFile/writeFile/editFile/execShell/searchFiles/... plus
 *   read-only git) are kept so the subtask can actually do its work.
 *
 * This filter is applied at the tool-NAME layer (before prepareTools), so the
 * existing prepareTools cache key (built from the final name list) stays
 * coherent — different run kinds produce different cache keys naturally.
 */
export function filterToolNamesForRunKind(
  toolNames: ReadonlyArray<string>,
  isSubtask: boolean,
): string[] {
  if (!isSubtask) return [...toolNames];
  return toolNames.filter((name) => !SUBTASK_REMOVED_TOOL_NAMES.has(name));
}

/**
 * Compute the set of tool names to block for a subtask, expressed as a
 * `disabledToolNames`-style array. Useful for the server path where the
 * existing `runtimeContext.blockedToolNames` mechanism is the config-layer
 * trim point: a platform can union this list with any caller-supplied blocks.
 */
export function subtaskBlockedToolNames(): string[] {
  return [...SUBTASK_REMOVED_TOOL_NAMES];
}