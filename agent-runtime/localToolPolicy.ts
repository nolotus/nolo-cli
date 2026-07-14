import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import { canonicalizeToolName } from "../ai/tools/toolNameAliases";
import { parseToolArgumentsJson } from "./parseToolArguments";
import { evaluateShellCommandPolicy } from "./shellCommandPolicy";

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
  if (decision.toolName === "execShell" && !args.confirmed) {
    const parsed = parseShellCommandPayload(args.call.arguments);
    const shellPolicy = evaluateShellCommandPolicy({
      command: parsed.command ?? parsed.cmd,
      input: parsed.input,
      userInput: args.call.userInput,
    });
    if (shellPolicy.verdict === "forbidden") {
      const error = new Error(shellPolicy.reason) as Error & {
        code?: string;
        policy?: Record<string, unknown>;
        permissionRequest?: Record<string, unknown>;
      };
      error.code = shellPolicy.code;
      error.policy = shellPolicy.policy;
      error.permissionRequest = shellPolicy.permissionRequest;
      throw error;
    }
  }
  return executor({
    ...args.call,
    name: decision.toolName,
  });
}
