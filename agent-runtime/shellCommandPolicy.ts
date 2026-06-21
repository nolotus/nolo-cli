import type { PermissionDecision, PermissionRequest } from "./actionGate";

export type ShellCommandPolicyVerdict = "allowed" | "forbidden";

export type ShellCommandPolicyResult =
  | {
      verdict: "allowed";
      permissionDecision: Extract<PermissionDecision, "allow">;
    }
  | {
      verdict: "forbidden";
      permissionDecision: Extract<PermissionDecision, "ask">;
      code: "destructive_action_requires_confirmation";
      reason: string;
      permissionRequest: PermissionRequest;
      policy: {
        capability: "destructive_action";
        target: "shell_command";
        detail: string;
      };
    };

const DESTRUCTIVE_NEGATION_PATTERNS = [
  "别删",
  "别删除",
  "不要删",
  "不要删除",
  "别乱删",
  "别动",
  "不要动",
  "不要清理",
  "不要清空",
  "不要重置",
  "don't delete",
  "do not delete",
  "don't remove",
  "do not remove",
  "without deleting",
] as const;

const EXPLICIT_DESTRUCTIVE_REQUEST_PATTERNS = [
  "删除",
  "删掉",
  "移除",
  "清理",
  "清空",
  "重置",
  "drop",
  "delete",
  "remove",
  "erase",
  "clean up",
  "reset",
] as const;

const SHELL_DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[^\n\r]*\s+)?/i,
  /\bremove-item\b/i,
  /\bdel\s+\/?[a-z]*\s+/i,
  /\berase\s+/i,
  /\brmdir\s+/i,
  /\brd\s+\/s\b/i,
  /\bgit\s+reset\s+(--hard\b|--merge\b|--keep\b)/i,
  /\bgit\s+clean\s+-[^\n\r]*f/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bgit\s+restore\s+--source=/i,
] as const;

const normalizeUserInput = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const containsAny = (text: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => text.includes(pattern));

const hasExplicitDestructivePermission = (userInput: unknown): boolean => {
  const normalized = normalizeUserInput(userInput);
  if (!normalized) return false;
  if (containsAny(normalized, DESTRUCTIVE_NEGATION_PATTERNS)) return false;
  return containsAny(normalized, EXPLICIT_DESTRUCTIVE_REQUEST_PATTERNS);
};

const buildCombinedShellInput = (args: {
  command?: unknown;
  input?: unknown;
}): string =>
  [
    typeof args.command === "string" ? args.command : "",
    typeof args.input === "string" ? args.input : "",
  ]
    .filter(Boolean)
    .join("\n");

export function isDestructiveShellCommand(args: {
  command?: unknown;
  input?: unknown;
}): boolean {
  const combined = buildCombinedShellInput(args);
  if (!combined.trim()) return false;
  return SHELL_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(combined));
}

export function evaluateShellCommandPolicy(args: {
  command?: unknown;
  input?: unknown;
  userInput?: unknown;
}): ShellCommandPolicyResult {
  if (
    isDestructiveShellCommand(args) &&
    !hasExplicitDestructivePermission(args.userInput)
  ) {
    return {
      verdict: "forbidden",
      permissionDecision: "ask",
      code: "destructive_action_requires_confirmation",
      reason:
        "当前运行默认禁止自动执行可能删除用户内容的 shell 命令。只有当用户在当前请求里明确要求删除/清理时，才能继续；否则请停止并先说明限制。",
      permissionRequest: {
        id: "permission-shell-destructive-action",
        tool: "execShell",
        action: "destructive_shell_command",
        title: "确认执行破坏性 shell 命令",
        body: "该命令可能删除或重置用户内容，需要用户明确确认后才能执行。",
        suggestedRule: {
          scope: "once",
          pattern: { capability: "destructive_action", target: "shell_command" },
        },
      },
      policy: {
        capability: "destructive_action",
        target: "shell_command",
        detail: "execShell destructive command",
      },
    };
  }

  return { verdict: "allowed", permissionDecision: "allow" };
}
