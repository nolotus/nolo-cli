// Pure CLI arg parsing helpers for the `nolo agent run` family of commands.
// Extracted from agentRunCommand.ts so the orchestration entry can stay
// focused on DI and message dispatch.
//
// No side effects: no process.env, no process.cwd, no fs reads. Callers
// that need external state (env, cwd) pass it in.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeServerOrigin } from "./core/serverOrigin";
import { asTrimmedLowercaseString } from "./core/trimmedLowercaseString";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import {
  isLocalCliAgentKey,
  LOCAL_CODEX_AGENT_KEY,
  resolveCliAgentKeyInput,
} from "./agentAliases";
import type { TaskEvidenceInput } from "./client/agentRun";
import type { AgentRuntimeRequestedMode } from "./agentRuntimeLocal";

// Re-export the local-CLI key check so orchestration files can stay
// decoupled from `./agentAliases` for the small set of helpers they need.
export { isLocalCliAgentKey } from "./agentAliases";

type EnvLike = Record<string, string | undefined>;

export type ParseAgentRunArgsOptions = {
  readTextFile?: (path: string) => string;
  commandPath?: string[];
};

export type ParsedAgentRunArgs = {
  agentKey: string;
  message: string;
  imageUrls: string[];
  allowShell: boolean;
  runtimeMode?: AgentRuntimeRequestedMode;
  continueDialogId?: string;
  spaceId?: string;
  category?: string;
  inheritedFromDialogKey?: string;
  parentDialogId?: string;
  parentWakeOnTerminal?: boolean;
  subjectDialogKey?: string;
  subjectRefs?: Array<{ kind: string; id: string; role?: string }>;
  allowedChildAgentKeys?: string[];
  allowedToolNames?: string[];
  blockedToolNames?: string[];
  background: boolean;
  noStream: boolean;
  cwd?: string;
  timeoutMs?: number;
  traceTools: boolean;
  eventsMode?: "jsonl";
  injectFeatureWorktreeInstruction: boolean;
  taskEvidence?: TaskEvidenceInput;
  workflowRef?: string;
  fallbackAgentKeys?: string[];
  skillRefs?: string[];
};

export function readFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function readRepeatedFlagValues(args: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

export function runtimeModeFromArgs(args: string[]): AgentRuntimeRequestedMode | undefined {
  if (args.includes("--local")) return "local";
  if (args.includes("--server")) return "server";
  if (args.includes("--auto")) return "auto";
  return undefined;
}

export function isFullstackCodingAgentRef(raw: string | undefined, resolved: string) {
  const normalized = asTrimmedLowercaseString(raw);
  return (
    normalized === "fullstack" ||
    normalized === "full-stack" ||
    normalized === "nolo-fullstack" ||
    normalized === "全栈" ||
    normalized === "nolo 全栈工程师" ||
    resolved === "fullstack"
  );
}

export function parsePositiveInteger(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function parseSubjectRef(raw: string): { kind: string; id: string; role?: string } | null {
  const value = raw.trim();
  if (!value) return null;
  const firstColon = value.indexOf(":");
  if (firstColon <= 0 || firstColon === value.length - 1) return null;
  const kind = value.slice(0, firstColon).trim();
  const rest = value.slice(firstColon + 1).trim();
  const lastColon = rest.lastIndexOf(":");
  const id = lastColon > 0 ? rest.slice(0, lastColon).trim() : rest;
  const role = lastColon > 0 ? rest.slice(lastColon + 1).trim() : "";
  if (!kind || !id) return null;
  return { kind, id, ...(role ? { role } : {}) };
}

const VALUELESS_FLAGS: Record<string, true> = {
  "--local": true,
  "--server": true,
  "--auto": true,
  "--dangerously-allow-shell": true,
  "--trace-tools": true,
  "--bg": true,
  "--no-stream": true,
  "--debug": true,
};

function isValuelessFlag(arg: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALUELESS_FLAGS, arg);
}

export function positionalArgs(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (isValuelessFlag(arg)) continue;
    if (arg.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

export function resolveRawAgentInput(args: string[], commandPath?: string[]) {
  const positional = positionalArgs(args);
  const isNoLogin =
    (commandPath?.join(" ") === "run" || commandPath?.join(" ") === "chat") &&
    !readFlagValue(args, "--agent");
  return readFlagValue(args, "--agent") ?? (isNoLogin ? LOCAL_CODEX_AGENT_KEY : positional[0]);
}

export function parseDialogReference(rawInput: string) {
  const normalized = rawInput.trim();
  if (normalized.startsWith("dialog-")) {
    const parts = normalized.split("-");
    return {
      dialogKey: normalized,
      dialogId: parts.at(-1) ?? normalized,
    };
  }
  const dialogMatch = normalized.match(/dialog-([a-zA-Z0-9]+)-([a-zA-Z0-9]+)/);
  if (dialogMatch) {
    return {
      dialogKey: `dialog-${dialogMatch[1]}-${dialogMatch[2]}`,
      dialogId: dialogMatch[2],
    };
  }
  return {
    dialogId: normalized,
  };
}

export function mimeTypeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

export function resolveServerUrl(env: EnvLike) {
  return normalizeServerOrigin(
    env.NOLO_SERVER || env.BASE_URL || DEFAULT_NOLO_SERVER_URL,
  );
}

export function buildLocalRunEnv(args: { env: EnvLike; allowShell: boolean }) {
  void args.allowShell;
  return {
    ...args.env,
  };
}

export function writeUsage(
  output: { write(chunk: string): unknown },
  commandPath?: string[]
) {
  const commandName = commandPath?.join(" ");
  if (commandName === "run") {
    output.write(
      "Usage: nolo run <message> [--cwd <path>] [--timeout-ms <n>] [--events jsonl]\n" +
        "       nolo run --msg <message> [--cwd <path>] [--image <url-or-path>] [--timeout-ms <n>]\n" +
        "Runs local Codex in the current workspace; no Nolo login required.\n"
    );
    return;
  }
  if (commandName === "chat") {
    output.write(
      "Usage: nolo chat <message> [--cwd <path>] [--events jsonl]\n" +
        "       nolo chat --agent <agent> (--msg <message>|--msg-file <path>) [--local|--server|--auto]\n" +
        "Without --agent, this uses local Codex in the current workspace; no Nolo login required.\n"
    );
    return;
  }
  output.write(
    "Usage: nolo agent run <agent> <message> [--local|--server|--auto] [--continue <dialogId>] [--cwd <path>]\n" +
      "       nolo agent run --agent <agent> (--msg <message>|--msg-file <path>) [--image <url-or-path>] [--space <spaceId>] [--category <name>] [--inherit-from-dialog <dialog>] [--parent-dialog <dialog>] [--subject-dialog <dialog>] [--subject-ref <kind:id[:role]>] [--task-row-dbkey <key>] [--allowed-child-agent <agent>] [--fallback-agent <agent>] (suggestions for agent to decide on quota) [--allowed-tool <tool>] [--blocked-tool <tool>] [--bg] [--timeout-ms <n>] [--events jsonl] [--no-stream] [--skill <dbKey-or-md-path>]\n"
  );
}

export function parseAgentRunArgs(
  args: string[],
  options: ParseAgentRunArgsOptions = {}
): ParsedAgentRunArgs | null {
  const positional = positionalArgs(args);
  const isNoLoginRunShorthand =
    (options.commandPath?.join(" ") === "run" || options.commandPath?.join(" ") === "chat") &&
    !readFlagValue(args, "--agent");
  const rawAgentKey = readFlagValue(args, "--agent") ?? (isNoLoginRunShorthand ? LOCAL_CODEX_AGENT_KEY : positional[0]);
  const agentKey = rawAgentKey ? resolveCliAgentKeyInput(rawAgentKey) : undefined;
  const explicitMsg = readFlagValue(args, "--msg");
  const msgFile = readFlagValue(args, "--msg-file");
  const fileMessage = msgFile
    ? (options.readTextFile ?? ((path: string) => readFileSync(path, "utf8")))(msgFile)
    : undefined;
  const rawMessage = explicitMsg ?? fileMessage ?? positional.slice(isNoLoginRunShorthand ? 0 : 1).join(" ");
  if (!agentKey || !rawMessage.trim()) return null;
  const message = rawMessage.trim();
  const runtimeMode = runtimeModeFromArgs(args);
  const continueDialogId = readFlagValue(args, "--continue") ?? readFlagValue(args, "--dialog");
  const spaceId = readFlagValue(args, "--space");
  const category = readFlagValue(args, "--category");
  const inheritedFromDialog = readFlagValue(args, "--inherit-from-dialog");
  const subjectDialog =
    readFlagValue(args, "--subject-dialog") ??
    readFlagValue(args, "--reference-dialog");
  const subjectDialogKey = subjectDialog?.trim();
  const subjectRefs = readRepeatedFlagValues(args, "--subject-ref")
    .map(parseSubjectRef)
    .filter((ref): ref is { kind: string; id: string; role?: string } => Boolean(ref));
  const allowedChildAgentKeys = readRepeatedFlagValues(args, "--allowed-child-agent")
    .map((value) => resolveCliAgentKeyInput(value.trim()))
    .filter(Boolean);
  const fallbackAgentKeys = readRepeatedFlagValues(args, "--fallback-agent")
    .map((value) => resolveCliAgentKeyInput(value.trim()))
    .filter(Boolean);
  const allowedToolNames = readRepeatedFlagValues(args, "--allowed-tool")
    .map((value) => value.trim())
    .filter(Boolean);
  const cwd = readFlagValue(args, "--cwd");
  const timeoutMs = parsePositiveInteger(readFlagValue(args, "--timeout-ms"));
  const rawEventsMode = readFlagValue(args, "--events");
  const eventsMode: ParsedAgentRunArgs["eventsMode"] =
    rawEventsMode === "jsonl" ? "jsonl" : undefined;
  const inheritedRef = inheritedFromDialog
    ? parseDialogReference(inheritedFromDialog)
    : undefined;
  const explicitLocalCliAgentDefault =
    isLocalCliAgentKey(agentKey) && runtimeMode !== "server";
  const explicitParentDialog = readFlagValue(args, "--parent-dialog");
  const parentDialogRef = explicitParentDialog
    ? parseDialogReference(explicitParentDialog)
    : undefined;
  const blockedToolNames = readRepeatedFlagValues(args, "--blocked-tool")
    .map((value) => value.trim())
    .filter(Boolean);
  const imageUrls = [
    ...readRepeatedFlagValues(args, "--image"),
    ...readRepeatedFlagValues(args, "--image-url"),
  ];
  const fullstackLocalWorkspaceDefault =
    isFullstackCodingAgentRef(rawAgentKey, agentKey) && runtimeMode !== "server";
  const workflowRef = readFlagValue(args, "--workflow");
  const skillRefs = readRepeatedFlagValues(args, "--skill")
    .map((v) => v.trim())
    .filter(Boolean);
  const taskRowDbKey = readFlagValue(args, "--task-row-dbkey");
  const artifactIds = readFlagValue(args, "--artifact-ids")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    agentKey,
    message,
    imageUrls,
    allowShell: args.includes("--dangerously-allow-shell") || fullstackLocalWorkspaceDefault || explicitLocalCliAgentDefault,
    traceTools: args.includes("--trace-tools"),
    ...(eventsMode ? { eventsMode } : {}),
    injectFeatureWorktreeInstruction: fullstackLocalWorkspaceDefault,
    ...(workflowRef ? { workflowRef } : {}),
    ...(skillRefs.length ? { skillRefs } : {}),
    ...(taskRowDbKey
      ? {
          taskEvidence: {
            rowDbKey: taskRowDbKey,
            ...(artifactIds?.length ? { artifactIds } : {}),
          },
        }
      : {}),
    ...(runtimeMode
      ? { runtimeMode }
      : fullstackLocalWorkspaceDefault || explicitLocalCliAgentDefault || args.includes("--dangerously-allow-shell")
        ? { runtimeMode: "local" as const }
        : {}),
    background: args.includes("--bg"),
    noStream: args.includes("--no-stream"),
    ...(continueDialogId ? { continueDialogId } : {}),
    ...(!continueDialogId && spaceId ? { spaceId } : {}),
    ...(category ? { category } : {}),
    ...(inheritedRef?.dialogKey ? { inheritedFromDialogKey: inheritedRef.dialogKey } : {}),
    ...(parentDialogRef?.dialogId || inheritedRef?.dialogId
      ? { parentDialogId: parentDialogRef?.dialogId ?? inheritedRef?.dialogId }
      : {}),
    ...(parentDialogRef?.dialogId ? { parentWakeOnTerminal: true } : {}),
    ...(subjectDialogKey ? { subjectDialogKey } : {}),
    ...(subjectRefs.length ? { subjectRefs } : {}),
    ...(allowedChildAgentKeys.length ? { allowedChildAgentKeys } : {}),
    ...(fallbackAgentKeys.length ? { fallbackAgentKeys } : {}),
    ...(allowedToolNames.length ? { allowedToolNames } : {}),
    ...(cwd ? { cwd } : {}),
    ...(blockedToolNames.length ? { blockedToolNames } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}
