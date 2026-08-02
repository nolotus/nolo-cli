import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import type { PermissionRequest } from "./actionGate";
import { canonicalizeToolName } from "../ai/tools/toolNameAliases";
import { parseToolArgumentsJson } from "./parseToolArguments";
import { isDestructiveShellCommand, resolveShellCommandArg } from "./shellCommandPolicy";

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

function parseShellCommandPayload(rawArguments: string) {
  return parseToolArgumentsJson(rawArguments) as {
    command?: unknown;
    cmd?: unknown;
    input?: unknown;
  };
}

/**
 * Reduce the parsed `command`/`cmd` payload into a single display string for
 * the confirm dialog. `execShell` calls arrive as either a string
 * (`{"cmd":"rm -rf ./tmp"}`) or an argv array (`{"command":["rm","-rf","./tmp"]}`);
 * both flatten to the shell line the user is about to approve.
 */
function toDisplayCommand(command: unknown): string | undefined {
  if (typeof command === "string") {
    const trimmed = command.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(command)) {
    const joined = command
      .map((item) => (typeof item === "string" ? item : String(item)))
      .filter((item) => item.length > 0)
      .join(" ")
      .trim();
    return joined ? joined : undefined;
  }
  return undefined;
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
  executors?: Record<string, (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult>>;
  confirmed?: boolean;
  /**
   * Optional per-turn AbortSignal propagated from the TUI's activeTurnAbort.
   * When present and the tool is execShell, the signal is injected into the
   * execShell executor call so Esc aborts a stuck child process tree.
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
  // When a per-turn abortSignal is present and the tool is execShell, inject
  // the signal into the execShell executor via its optional second arg. Other
  // executors keep their single-arg contract and ignore the extra opts.
  const effectiveExecutor =
    args.abortSignal && decision.toolName === "execShell" && args.executors
      ? (call: AgentRuntimeToolCallInput) =>
          (args.executors!.execShell as unknown as (
            call: AgentRuntimeToolCallInput,
            opts?: { abortSignal?: AbortSignal; detachMs?: number },
          ) => Promise<AgentRuntimeToolResult>)(call, {
            abortSignal: args.abortSignal,
            detachMs: args.detachMs,
          })
      : executor;
  const guardEnabled = args.enableDestructiveShellGuard !== false;
  if (decision.toolName === "execShell" && !args.confirmed && guardEnabled) {
    const parsed = parseShellCommandPayload(args.call.arguments);
    // 命令文本按全部别名取：只读 command/cmd 会让 `bash` / `runCommand` /
    // `execute_command` 等形态从闸门下面绕过去。别名清单与实际执行命令的代码
    // 共用一份（shellCommandPolicy.SHELL_COMMAND_ARG_ALIASES）。
    const rawCommand = resolveShellCommandArg(parsed as Record<string, unknown>);
    if (isDestructiveShellCommand({ command: rawCommand, input: parsed.input })) {
      const command = toDisplayCommand(rawCommand);
      const request: PermissionRequest = {
        id: "permission-shell-destructive-action",
        tool: "execShell",
        action: "destructive_shell_command",
        title: "确认执行破坏性 shell 命令",
        body: "该命令可能删除或重置用户内容，需要用户明确确认后才能执行。",
        ...(command ? { command } : {}),
        suggestedRule: {
          scope: "once",
          pattern: { capability: "destructive_action", target: "shell_command" },
        },
      };
      const buildBlockedError = (reason: string) => {
        const error = new Error(reason) as Error & {
          code?: string;
          policy?: Record<string, unknown>;
          permissionRequest?: Record<string, unknown>;
        };
        error.code = "destructive_action_requires_confirmation";
        error.policy = {
          capability: "destructive_action",
          target: "shell_command",
          detail: "execShell destructive command",
        };
        error.permissionRequest = request;
        return error;
      };
      // 「没有确认回调」这个信号本身是歧义的：既可能是"无头 CLI，用户自己起的
      // 任务，拦了只会让模型反复重试 rm 空转"，也可能是"用户面前的应用没把确认
      // 通道接上"。以前隐式取前者，于是 desktop 侧 rm -rf 直接执行。
      // 现在要求调用方显式声明，默认保持无头路径的既有行为。
      if (!args.confirmDestructiveAction) {
        if (args.blockDestructiveWithoutConfirmation) {
          throw buildBlockedError(
            "destructive shell command blocked: no confirmation channel available",
          );
        }
        return effectiveExecutor({
          ...args.call,
          name: decision.toolName,
        });
      }
      const confirmed = await args.confirmDestructiveAction(request);
      if (!confirmed) {
        throw buildBlockedError(
          "destructive shell command blocked: user declined confirmation",
        );
      }
    }
  }
  return effectiveExecutor({
    ...args.call,
    name: decision.toolName,
  });
}
