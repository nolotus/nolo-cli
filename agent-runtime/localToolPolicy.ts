import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import type { PermissionRequest } from "./actionGate";
import { canonicalizeToolName } from "../ai/tools/toolNameAliases";
import { evaluateExecShellDestructiveGuard } from "./capabilities/capabilityPolicy";

type EnvLike = Record<string, string | undefined>;

export type LocalToolPolicyDecision =
  | { allowed: true; toolName: string }
  | { allowed: false; toolName: string; reason: string };

const NEVER_LOCAL_TOOLS = new Set([
  "deleteSpaces",
  "updateAgent",
  "updateSelf",
  "createAgent",
]);

const REMOVED_LOCAL_TOOLS = new Set([
  "gitStatus",
  "gitDiff",
  "gitCreateBranch",
  "gitAdd",
  "gitCommit",
  "commitWorkspace",
]);

/**
 * Tools every local agent gets without an allowlist. Exported because tests
 * used to keep their own transcribed copies, which silently fell behind each
 * time a tool was added here — a stale copy makes a passing test meaningless.
 */
export const DEFAULT_LOCAL_TOOLS = new Set([
  "listFiles",
  "readFile",
  "writeFile",
  "editFile",
  "globFiles",
  "searchFiles",
  "execShell",
  "launchProcess",
  "listProcesses",
  // Scheduling tools: forking/observing sub-agents is a declared capability
  // of capable agents, and the blast radius is strictly narrower than
  // execShell (already default-enabled). Requiring an env allowlist for these
  // while execShell is open by default inverted the risk model and forced every
  // new local user to hand-edit .env files before sub-agent tasks worked.
  "startAgentRun",
  "controlAgentRun",
]);

function parseToolAllowlist(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .flatMap((item) => {
      const trimmed = item.trim();
      return trimmed ? [trimmed] : [];
    });
}

function normalizeLocalToolName(toolName: string) {
  return canonicalizeToolName(
    String(toolName ?? "").replace(/^functions\./, "").trim(),
  );
}

function isRestrictedLocalToolMode(env: EnvLike) {
  return env.NOLO_LOCAL_TOOL_MODE === "restricted";
}

function isToolDeclaredOrExplicitlyFree(args: {
  env: EnvLike;
  agentToolNames?: string[];
  toolName: string;
}) {
  return (
    new Set(args.agentToolNames ?? []).has(args.toolName) ||
    args.env.NOLO_LOCAL_ALLOW_UNDECLARED_TOOLS === "1"
  );
}

export function resolveLocalToolPolicy(args: {
  env: EnvLike;
  agentToolNames?: string[];
  toolName: string;
}): LocalToolPolicyDecision {
  const toolName = normalizeLocalToolName(args.toolName);
  const restrictedMode = isRestrictedLocalToolMode(args.env);
  if (!toolName) {
    return {
      allowed: false,
      toolName,
      reason: "Tool name is required.",
    };
  }

  if (NEVER_LOCAL_TOOLS.has(toolName)) {
    return {
      allowed: false,
      toolName,
      reason: `${toolName} is blocked by the local runtime safety policy.`,
    };
  }

  if (REMOVED_LOCAL_TOOLS.has(toolName)) {
    return {
      allowed: false,
      toolName,
      reason: `${toolName} has been removed from the local runtime tool surface. Use execShell in shell-enabled workspace runs when shell is needed.`,
    };
  }

  const allowedByEnv = new Set(parseToolAllowlist(args.env.NOLO_LOCAL_ALLOWED_TOOLS));
  const agentTools = new Set(
    (args.agentToolNames ?? []).flatMap((item) => {
      const normalized = normalizeLocalToolName(item);
      return normalized ? [normalized] : [];
    }),
  );
  if (!restrictedMode && agentTools.has(toolName)) {
    return { allowed: true, toolName };
  }
  if (DEFAULT_LOCAL_TOOLS.has(toolName) && agentTools.has(toolName)) {
    return { allowed: true, toolName };
  }
  if (allowedByEnv.has(toolName) && agentTools.has(toolName)) {
    return { allowed: true, toolName };
  }

  return {
    allowed: false,
    toolName,
    reason:
      `${toolName} is not enabled for local runtime runs. ` +
      "The agent must declare the tool in its manifest; in restricted mode (NOLO_LOCAL_TOOL_MODE=restricted) non-default tools also require adding to NOLO_LOCAL_ALLOWED_TOOLS (e.g. NOLO_LOCAL_ALLOWED_TOOLS=someCustomTool) and restarting the session so the env var loads.",
  };
}

export async function executeLocalToolWithPolicy(args: {
  env: EnvLike;
  agentToolNames?: string[];
  call: AgentRuntimeToolCallInput;
  executors?: Record<string, (call: AgentRuntimeToolCallInput, opts?: Record<string, unknown>) => Promise<AgentRuntimeToolResult>>;
  confirmed?: boolean;
  /**
   * Optional per-turn AbortSignal propagated from the TUI's activeTurnAbort.
   * Injected into the tool executor call so Esc aborts stuck child process trees.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional override for the execShell auto-detach threshold (ms). When a
   * command runs longer than this it is promoted to a background process.
   */
  detachMs?: number;
  /**
   * Optional confirmation callback for destructive shell commands. When
   * provided, a destructive `rm`/`git reset --hard`/etc. triggers this
   * callback BEFORE execution; the command runs only if it returns true.
   * When absent (non-interactive CLI / machine WS dispatch), destructive
   * commands run without a prompt — blocking them with no confirmation
   * channel only stalled the agent turn for minutes while the model
   * retried the same `rm`.
   */
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /**
   * Whether to enforce the destructive-shell-command guard. Defaults to true.
   * Kept for callers that still gate the guard via a separate flag; when false,
   * destructive commands always run. Prefer passing `confirmDestructiveAction`
   * instead so the guard runs pre-execution with a real prompt.
   */
  enableDestructiveShellGuard?: boolean;
  /**
   * 破坏性命令命中、但没有 `confirmDestructiveAction` 通道时怎么办。
   *
   * true  = 拒绝执行并抛 destructive_action_requires_confirmation。
   *         用户面前的运行时（desktop turn service）应当选这个：UI 没接上
   *         确认通道不代表用户默许 rm -rf。
   * false = 照常执行（默认）。无头 CLI / machine WS dispatch 是用户自己起的
   *         任务，拦下来只会让模型反复重试同一条 rm 空转数分钟。
   *
   * 之所以要显式声明：「没有回调」这个信号对两种场景含义相反，隐式取其一
   * 必然让另一种出问题——实测就是 desktop 侧破坏性命令直接执行。
   */
  blockDestructiveWithoutConfirmation?: boolean;
}): Promise<AgentRuntimeToolResult> {
  const decision = resolveLocalToolPolicy({
    env: args.env,
    agentToolNames: args.agentToolNames,
    toolName: args.call.name,
  });
  if (!decision.allowed) throw new Error(decision.reason);

  const executor = args.executors?.[decision.toolName];
  if (!executor) {
    throw new Error(`${decision.toolName} is allowed by policy but no local executor is registered.`);
  }
  const opts: Record<string, unknown> = {
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    ...(args.detachMs !== undefined ? { detachMs: args.detachMs } : {}),
    ...(args.confirmed !== undefined ? { confirmed: args.confirmed } : {}),
    ...(args.enableDestructiveShellGuard !== undefined
      ? { enableDestructiveShellGuard: args.enableDestructiveShellGuard }
      : {}),
    ...(args.confirmDestructiveAction
      ? { confirmDestructiveAction: args.confirmDestructiveAction }
      : {}),
    ...(args.blockDestructiveWithoutConfirmation !== undefined
      ? { blockDestructiveWithoutConfirmation: args.blockDestructiveWithoutConfirmation }
      : {}),
  };

  if (decision.toolName === "execShell") {
    let parsedInput: unknown = args.call.arguments;
    if (typeof parsedInput === "string") {
      try {
        parsedInput = JSON.parse(parsedInput);
      } catch {
        parsedInput = { command: parsedInput };
      }
    }
    await evaluateExecShellDestructiveGuard(parsedInput, opts as any);
    opts.confirmed = true;
  }

  return executor(
    {
      ...args.call,
      name: decision.toolName,
    },
    opts,
  );
}
