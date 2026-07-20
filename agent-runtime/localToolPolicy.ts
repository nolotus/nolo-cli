import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import type { PermissionRequest } from "./actionGate";
import { canonicalizeToolName } from "../ai/tools/toolNameAliases";
import { parseToolArgumentsJson } from "./parseToolArguments";
import { isDestructiveShellCommand } from "./shellCommandPolicy";

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

const DEFAULT_LOCAL_TOOLS = new Set([
  "listFiles",
  "readFile",
  "writeFile",
  "editFile",
  "globFiles",
  "searchFiles",
  "execShell",
  "launchProcess",
  "listProcesses",
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
      "Set NOLO_LOCAL_ALLOWED_TOOLS and make sure the agent declares the tool before using it locally.",
  };
}

export async function executeLocalToolWithPolicy(args: {
  env: EnvLike;
  agentToolNames?: string[];
  call: AgentRuntimeToolCallInput;
  executors?: Record<string, (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult>>;
  confirmed?: boolean;
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
  const guardEnabled = args.enableDestructiveShellGuard !== false;
  if (decision.toolName === "execShell" && !args.confirmed && guardEnabled) {
    const parsed = parseShellCommandPayload(args.call.arguments);
    if (isDestructiveShellCommand({ command: parsed.command ?? parsed.cmd, input: parsed.input })) {
      if (args.confirmDestructiveAction) {
        const command = toDisplayCommand(parsed.command ?? parsed.cmd);
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
        const confirmed = await args.confirmDestructiveAction(request);
        if (!confirmed) {
          const error = new Error(
            "destructive shell command blocked: user declined confirmation",
          ) as Error & { code?: string; policy?: Record<string, unknown>; permissionRequest?: Record<string, unknown> };
          error.code = "destructive_action_requires_confirmation";
          error.policy = { capability: "destructive_action", target: "shell_command", detail: "execShell destructive command" };
          error.permissionRequest = request;
          throw error;
        }
      }
    }
  }
  return executor({
    ...args.call,
    name: decision.toolName,
  });
}
