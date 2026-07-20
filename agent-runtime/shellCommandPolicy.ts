import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import type { PermissionDecision, PermissionRequest } from "./actionGate";

export type ShellCommandPolicyVerdict = "allowed" | "forbidden";

export type ShellCommandPolicyResult =
  | {
      verdict: "allowed";
      permissionDecision: Extract<PermissionDecision, "allow">;
      longRunningHint?: boolean;
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

// Contexts where a quoted string may itself be executed as code; when any of
// these appear we must NOT strip quoted segments before scanning.
const SHELL_STRING_EXECUTION_PATTERNS = [
  /\b(?:ba|da|z|k)?sh\b/i,
  /\beval\b/i,
  /\bexec\b/i,
  /\bxargs\b/i,
  /\bsource\s/i,
  /\b(?:node|deno|bun)\s+(?:-\S+\s+)*(?:-e|--eval)\b/i,
  /\bpython[\d.]*\s+(?:-\S+\s+)*-c\b/i,
  /\b(?:perl|ruby)\s+(?:-\S+\s+)*-e\b/i,
] as const;

// Blank out the contents of single/double-quoted segments so that merely
// *mentioning* a destructive command (e.g. in a git commit message) does not
// trip the destructive-command patterns. Quote delimiters are kept.
const stripQuotedSegments = (text: string): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return out + text.slice(i);
      out += "''";
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return out + text.slice(i);
      out += '""';
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
};

const normalizeUserInput = (value: unknown): string =>
  asTrimmedLowercaseString(value);

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
  const scannable = SHELL_STRING_EXECUTION_PATTERNS.some((pattern) =>
    pattern.test(combined),
  )
    ? combined
    : stripQuotedSegments(combined);
  return SHELL_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(scannable));
}

// Patterns that indicate a long-running process (dev server / watcher / service).
// Detect to hint the agent toward launchProcess; do NOT block — heuristics can
// false-positive (e.g. grep "dev"), and a blocked command is worse than a hint.
const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
  /\b(run|npm|yarn|pnpm|bun|npx)\s+(run\s+)?(dev|serve|start|watch)\b/i,
  /(^|[\s=&|;])--watch\b/i,
  /\bvite\b.*\b(dev|serve)\b/i,
  /\bwebpack\b.*(?:--watch|serve)\b/i,
  /\bnodemon\b/i,
  /\bgatsby\b.*\b(develop|serve)\b/i,
  /\bnext\b.*\b(dev|start)\b/i,
  /\belectron\b.*\bdev\b/i,
  /\bforever\b/i,
  /\bpm2\b.*\bstart\b/i,
];

export function isLongRunningShellCommand(args: {
  command?: unknown;
  input?: unknown;
}): boolean {
  const combined = buildCombinedShellInput(args);
  if (!combined.trim()) return false;
  const scannable = SHELL_STRING_EXECUTION_PATTERNS.some((pattern) =>
    pattern.test(combined),
  )
    ? combined
    : stripQuotedSegments(combined);
  return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(scannable));
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

  const longRunningHint = isLongRunningShellCommand(args);
  return {
    verdict: "allowed",
    permissionDecision: "allow",
    ...(longRunningHint ? { longRunningHint: true } : {}),
  };
}
