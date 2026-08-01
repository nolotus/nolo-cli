/**
 * Shared types and helpers for agent run dispatch — used by both
 * CLI-side (agentRun.ts) and connector-side (machineWsRunDispatch.ts).
 * This is the shared contract seam between the two dispatch paths.
 *
 * Keep this file focused on pure types and pure helpers (no side effects).
 * Side-effectful orchestration stays in agentRun.ts / machineWsRunDispatch.ts.
 */

import { isLoopbackUrl } from "../../core/localOrigins";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import { asTrimmedString } from "../../core/trimmedString";
import type { AgentRuntimeRequestedMode, AgentRuntimeHostAdapter, AgentRuntimeToolResult } from "../agentRuntimeLocal";
import type { LocalAgentActionGate, LocalAgentLoopEvent } from "../../agent-runtime/localLoop";
import type { PermissionRequest } from "../../agent-runtime/actionGate";
import type { UserChoiceRequest, UserChoiceResult } from "./localRuntimeAdapter";
import type { CliFetchImpl } from "../cliFetch";
import type { ModelLayerOverride } from "../../agent-runtime/modelLayerOverride";
import type { TurnTokenUsage } from "./tokenUsage";

export type EnvLike = Record<string, string | undefined>;

/**
 * Minimal output stream shape used by the CLI agent run path. Mirrors the
 * subset of Node's WritableStream the runner actually calls (write + isTTY).
 */
export type OutputLike = {
  write: (chunk: string) => void;
  isTTY?: boolean;
};

/**
 * What the dispatch resolver decided should happen for this agent run.
 * runAgentTurn() executes the plan as a thin orchestrator.
 */
export type DispatchPlan = {
  /** Resolved auth token (empty string = none available). */
  authToken: string;
  /** Whether to attempt a local agent turn first. */
  tryLocal: boolean;
  /** Whether HTTP/server fallback is available when local fails or is skipped. */
  tryHttp: boolean;
  /** Whether to refresh a missing local agent config and retry local once. */
  retryLocalOnMissingConfig: boolean;
  /** The resolved agent runtime request mode. */
  requestedMode: "local" | "server" | "auto";
};

export function resolveAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || env.BENCHMARK_AUTH_TOKEN || "";
}

/**
 * Check whether an agent config represents a machine-bound localhost
 * custom provider — the agent is bound to a specific machine AND its
 * custom provider URL points to 127.0.0.1 or localhost.
 *
 * Used in both CLI auto-routing and connector dispatch to decide
 * whether local runtime should be skipped on this machine.
 */
export function isMachineBoundLocalhostCustomProvider(agentConfig: any) {
  const machineId =
    agentConfig?.runtimeBinding && typeof agentConfig.runtimeBinding === "object"
      ? String(agentConfig.runtimeBinding.machineId ?? "").trim()
      : "";
  const providerUrl = asTrimmedString(agentConfig?.customProviderUrl);
  if (!machineId || !providerUrl) return false;
  return isLoopbackUrl(providerUrl);
}

/**
 * Resolve the bound machine ID from an agent's runtime binding.
 */
export function resolveBoundMachineId(agentConfig: any) {
  return agentConfig?.runtimeBinding && typeof agentConfig.runtimeBinding === "object"
    ? String(agentConfig.runtimeBinding.machineId ?? "").trim()
    : "";
}

/**
 * Set of recognized CLI provider names.
 */
export const CLI_PROVIDER_NAMES = new Set([
  "agy",
  "claude",
  "codex",
  "copilot",
  "gemini",
  "grok",
  "kimi",
  "opencode",
  "qoder",
]);

/**
 * Check whether the agent config maps to a CLI provider.
 */
export function isCliProviderAgentConfig(agentConfig: any) {
  const cliProvider = asTrimmedLowercaseString(agentConfig?.cliProvider);
  const provider = asTrimmedLowercaseString(agentConfig?.provider);
  return Boolean(cliProvider) || CLI_PROVIDER_NAMES.has(provider);
}

/**
 * Detect the current machine ID from environment or machine info.
 */
export async function detectCurrentMachineId(env: EnvLike): Promise<string | undefined> {
  const fromEnv = (env.NOLO_CURRENT_MACHINE_ID || env.NOLO_MACHINE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const { detectMachineInfo } = await import("../../connector-experimental/machineInfo");
    const machine = await detectMachineInfo({ probeLaunchable: true });
    return asOptionalTrimmedString(machine?.machineId);
  } catch {
    return undefined;
  }
}

export type AgentRunSubjectRef = {
  kind: string;
  id: string;
  role?: string;
};

export type TaskEvidenceInput = {
  rowDbKey: string;
  artifactIds?: string[];
};

export type RunAgentTurnOptions = {
  agentName: string;
  agentKey: string;
  serverUrl: string;
  message: string;
  imageUrls?: string[];
  continueDialogId?: string;
  spaceId?: string;
  category?: string;
  inheritedFromDialogKey?: string;
  parentDialogId?: string;
  parentWakeOnTerminal?: boolean;
  subjectDialogKey?: string;
  subjectRefs?: AgentRunSubjectRef[];
  allowedChildAgentKeys?: string[];
  blockedToolNames?: string[];
  allowedToolNames?: string[];
  background?: boolean;
  noStream?: boolean;
  /**
   * Memory-only / ephemeral mode: skip all dialog & message persistence
   * (LevelDB writes and remote server sync). The turn runs in-process and
   * its result is discarded once the run returns. Intended for liveness
   * probes (e.g. nolo-plan探活). Only effective with the local runtime.
   *
   * Note: this covers `adapter.saveTurn` (dialog + messages) and
   * `adapter.loadDialogHistory`. The `callAgent` sub-agent path writes its
   * own pending/failed child-dialog records directly to the store and is NOT
   * suppressed — but a liveness probe (a single short reply, no tool calls)
   * never reaches that path, so in practice nothing is persisted.
   */
  ephemeral?: boolean;
  scriptDir: string;
  env: EnvLike;
  output: OutputLike;
  runtimeMode?: AgentRuntimeRequestedMode;
  localRuntimeAdapter?: AgentRuntimeHostAdapter;
  localRuntimeAdapterFactory?: (
    env: EnvLike,
    options?: { cwd?: string },
  ) => AgentRuntimeHostAdapter;
  localRuntimeCwd?: string;
  timeoutMs?: number;
  traceTools?: boolean;
  eventsMode?: "jsonl";
  taskEvidence?: TaskEvidenceInput;
  fetchImpl?: CliFetchImpl;
  currentMachineIdResolver?: (env: EnvLike) => Promise<string | undefined>;
  actionGateHandler?: (
    gate: LocalAgentActionGate,
  ) => Promise<AgentRuntimeToolResult | void>;
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /** Interactive ui_ask_choice dialog; absent in headless/CI mode. */
  requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
  /** Cooperative stop (TUI Esc): aborted turns return exitCode 0 + streamInterrupted. */
  abortSignal?: AbortSignal;
  /** Local loop lifecycle events; used by the CLI runner to write heartbeat activity to the registry. */
  onLoopEvent?: (event: LocalAgentLoopEvent) => void;
  /**
   * quick-chat 自动路由的「模型层覆盖」：分类路由落到通用档（tier agent）时，
   * 用用户选择的 agent 的 model 层替换档位 agent 的 model 层。
   * server 模式随 body 的 runtimeOptions.quickChatModelOverride 由服务端应用；
   * local 模式在 adapter 读出 tier 配置后本地应用。
   */
  modelOverride?: ModelLayerOverride | null;
  /**
   * Extra context blocks appended to the system prompt after the agent's own
   * prompt, before the user message. Used for skill content and AGENTS.md
   * project instructions — placing them here (instead of prepending to the
   * user message) preserves LLM prefix-cache hits on the system+history prefix.
   */
  extraContextBlocks?: string[];
  /**
   * Context blocks with cacheScope metadata — the CLI analogue of desktop's
   * contextBlockScopes. When provided, localLoop.buildMessages splits the
   * system message into a stable prefix (session-scope blocks + agent prompt)
   * and a dynamic suffix (turn-scope blocks), enabling prefix-cache hits.
   * Falls back to extraContextBlocks (plain strings, no scope split).
   */
  contextBlockScopes?: Array<{ content: string; cacheScope: "session" | "turn" }>;
  /**
   * 当前活动标签的外部接收者（TUI 用来在 composer 上方画 docked 活动行）。
   * 传入时 Spinner 不再向 output 写帧，避免两个 live 指示重复。
   */
  activityReporter?: (label: string | null) => void;
};

export type RunAgentTurnResult = {
  exitCode: number;
  dialogId?: string;
  streamInterrupted?: boolean;
  localError?: unknown;
  turnTokens?: TurnTokenUsage;
};
