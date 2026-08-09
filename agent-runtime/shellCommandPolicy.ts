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

/**
 * execShell 的命令参数别名。不同模型会用不同的键名发同一个命令。
 *
 * 这份清单必须与实际执行命令的代码看同一组键——否则「检查的字段」和
 * 「执行的字段」会错开，破坏性命令就能从安全闸门下面绕过去。
 * 服务端 toolExecutor 的 normalizeToolExecutionArgs 复用这里，不再各存一份。
 */
export const SHELL_COMMAND_ARG_ALIASES = [
  "command",
  "runCommand",
  "run_command",
  "terminalCommand",
  "terminal_command",
  "runInBash",
  "run_in_bash",
  "executeCommand",
  "execute_command",
  "execShell",
  "bash",
  "cmd",
] as const;

/** 按别名顺序取出 execShell 的命令文本；都没有则 undefined。 */
export const resolveShellCommandArg = (
  args: Record<string, unknown> | null | undefined,
): unknown => {
  if (!args) return undefined;
  for (const key of SHELL_COMMAND_ARG_ALIASES) {
    const value = args[key];
    if (value != null) return value;
  }
  return undefined;
};

const buildCombinedShellInput = (args: {
  command?: unknown;
  input?: unknown;
}): string => {
  // 只读 args.command 会漏掉别名形态。实测（2026-07-27）：desktop 路径下
  // `execShell({ cmd: "rm -rf ./tmp" })` 因为 args.command 为 undefined 而被
  // 判成「非破坏性」，直接跳过确认执行——服务端因为先做了别名归一化没这个洞。
  const command = resolveShellCommandArg(args as Record<string, unknown>);
  return [
    typeof command === "string" ? command : "",
    typeof args.input === "string" ? args.input : "",
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * Reduce a tool-call payload to the text policy patterns should scan, or
 * undefined when there is nothing to scan. Commands that embed shell-string
 * execution (`bash -c ...`, `env sh -c ...`) are scanned verbatim — the outer
 * command is trivially non-destructive, so only the inner string matters; for
 * plain command lines quoted segments are blanked first so keywords inside
 * commit messages / echoed strings cannot trigger policy.
 */
function resolveScannableShellInput(args: {
  command?: unknown;
  input?: unknown;
}): string | undefined {
  const combined = buildCombinedShellInput(args);
  if (!combined.trim()) return undefined;
  return SHELL_STRING_EXECUTION_PATTERNS.some((pattern) =>
    pattern.test(combined),
  )
    ? combined
    : stripQuotedSegments(combined);
}

export function isDestructiveShellCommand(args: {
  command?: unknown;
  input?: unknown;
}): boolean {
  const scannable = resolveScannableShellInput(args);
  if (scannable === undefined) return false;
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
  const scannable = resolveScannableShellInput(args);
  if (scannable === undefined) return false;
  return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(scannable));
}

// Commands that clearly will not exit on their own (long sleeps, tail -f,
// watch, infinite loops, plus the dev-server/watcher patterns above). Unlike
// longRunningHint (prompt-only), these are acted on: execShell promotes them
// to background immediately instead of freezing the conversation. A false
// positive is cheap — the command still runs, just in the background — while
// a false negative blocks the whole turn, so err on the detach side.
const IMMEDIATE_DETACH_COMMAND_PATTERNS: RegExp[] = [
  /\btail\s+(?:-\S*[fF]\S*|--follow)\b/,
  /\bwatch\s+\S/,
  /\bwhile\s+(?:true|:|\[\s*true\s*\])\s*;\s*do\b/,
];

// Sleeps longer than this many seconds are detached immediately. Short sleeps
// (test pacing, retry backoff) stay inline so the turn keeps their ordering.
// Exported: the execShell tool description (localWorkspaceToolDefs) quotes
// this value verbatim — a consistency test locks the two together.
export const IMMEDIATE_DETACH_SLEEP_THRESHOLD_SECONDS = 5;

const SLEEP_PREFIX_PATTERN =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:nohup\s+|time\s+)*sleep\s+(\S+)/;

function parseSleepDurationSeconds(token: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/i.exec(token);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  const factor =
    unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 1;
  return value * factor;
}

function isLongSleepCommand(scannable: string): boolean {
  const match = SLEEP_PREFIX_PATTERN.exec(scannable.trim());
  if (!match) return false;
  const durationToken = match[1] ?? "";
  if (/^inf(inity)?$/i.test(durationToken)) return true;
  const seconds = parseSleepDurationSeconds(durationToken);
  // Unparseable duration (e.g. `sleep $DELAY`): detach to be safe — a blocked
  // turn is worse than a backgrounded command.
  if (seconds === undefined) return true;
  return seconds > IMMEDIATE_DETACH_SLEEP_THRESHOLD_SECONDS;
}

export function isImmediateDetachShellCommand(args: {
  command?: unknown;
  input?: unknown;
}): boolean {
  const scannable = resolveScannableShellInput(args);
  if (scannable === undefined) return false;
  return (
    isLongSleepCommand(scannable)
    || LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(scannable))
    || IMMEDIATE_DETACH_COMMAND_PATTERNS.some((pattern) =>
      pattern.test(scannable),
    )
  );
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
