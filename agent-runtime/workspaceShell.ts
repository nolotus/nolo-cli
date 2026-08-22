// packages/agent-runtime/workspaceShell.ts
//
// Neutral low-level primitives for workspace shell execution, command building,
// escape checking, interactive command handoff, timeout resolution, and process tracking.
//
// Extracted to avoid circular dependencies between execShellCapability and workspace adapters.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn as spawnChildProcess } from "node:child_process";

import { toErrorMessage } from "../core/errorMessage";
import { isRecord } from "../core/isRecord";
import { asOptionalFiniteNumber } from "../core/optionalNumber";
import { asOptionalPositiveFiniteNumber } from "../core/optionalPositiveNumber";
import { asOptionalTrimmedString } from "../core/optionalString";
import type { AgentRuntimeToolResult } from "./hostAdapter";
import { resolveExecutableOnPath } from "./runtimeCompat";
import { getProcessRegistry } from "./processRegistry";

export const EXEC_SHELL_TIMEOUT_ENV = "NOLO_EXEC_SHELL_TIMEOUT_MS";
export const EXEC_SHELL_DETACH_ENV = "NOLO_EXEC_SHELL_DETACH_MS";
export const DEFAULT_EXEC_SHELL_DETACH_MS = 120000;

export type ActivityRef =
  | { type: "file"; path: string }
  | { type: "terminal"; id?: string; label?: string }
  | { type: "url"; url: string; label?: string };

export type ToolActivityAction = {
  title: string;
  kind?: string;
  detail?: string;
  refs?: ActivityRef[];
};

export type ToolActivityPhase = {
  id: string;
  title: string;
  index?: number;
  total?: number;
  status?: "pending" | "running" | "success" | "failed";
};

export type ActivityPlan = {
  title?: string;
  phases: Array<{
    id: string;
    title: string;
    index?: number;
    status?: "pending" | "running" | "success" | "failed";
  }>;
};

export type ToolActivity = Partial<ToolActivityAction> & {
  phase?: ToolActivityPhase;
  action?: ToolActivityAction;
  plan?: ActivityPlan;
};

function readTrimmedString(value: unknown): string | undefined {
  return asOptionalTrimmedString(value);
}

function extractActivityRefs(rawRefs: unknown): ActivityRef[] | undefined {
  if (!Array.isArray(rawRefs)) return undefined;
  const refs = rawRefs.flatMap((entry): ActivityRef[] => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ type: "file", path: entry.trim() }];
    }
    if (!isRecord(entry)) return [];
    const path = readTrimmedString(entry.path);
    if (path) return [{ type: "file", path }];
    const terminalId = readTrimmedString(entry.id);
    const terminalLabel = readTrimmedString(entry.label);
    if (entry.type === "terminal" || terminalId || terminalLabel) {
      return [{
        type: "terminal",
        ...(terminalId ? { id: terminalId } : {}),
        ...(terminalLabel ? { label: terminalLabel } : {}),
      }];
    }
    if (entry.type === "url" || typeof entry.url === "string") {
      const url = readTrimmedString(entry.url);
      const label = readTrimmedString(entry.label);
      return url ? [{ type: "url", url, ...(label ? { label } : {}) }] : [];
    }
    return [];
  });
  return refs.length ? refs : undefined;
}

function extractActivityAction(rawAction: unknown): ToolActivityAction | undefined {
  if (!isRecord(rawAction)) return undefined;
  const title = readTrimmedString(rawAction.title);
  if (!title) return undefined;
  const kind = readTrimmedString(rawAction.kind);
  const detail = readTrimmedString(rawAction.detail);
  const refs = extractActivityRefs(rawAction.refs);
  return {
    title,
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(refs ? { refs } : {}),
  };
}

function extractActivityPhase(rawPhase: unknown): ToolActivityPhase | undefined {
  if (!isRecord(rawPhase)) return undefined;
  const title = readTrimmedString(rawPhase.title);
  if (!title) return undefined;
  const id = readTrimmedString(rawPhase.id) || title.toLowerCase().replace(/\s+/g, "-");
  const index = asOptionalFiniteNumber(rawPhase.index);
  const total = asOptionalFiniteNumber(rawPhase.total);
  const status =
    rawPhase.status === "pending" ||
    rawPhase.status === "running" ||
    rawPhase.status === "success" ||
    rawPhase.status === "failed"
      ? rawPhase.status
      : undefined;
  return {
    id,
    title,
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(status ? { status } : {}),
  };
}

function extractActivityPlan(rawPlan: unknown): ActivityPlan | undefined {
  if (!isRecord(rawPlan)) return undefined;
  if (!Array.isArray(rawPlan.phases)) return undefined;
  const phases = rawPlan.phases.flatMap((entry, index): ActivityPlan["phases"] => {
    const phase = extractActivityPhase(entry);
    if (!phase) return [];
    return [{
      id: phase.id,
      title: phase.title,
      index: phase.index ?? index + 1,
      ...(phase.status ? { status: phase.status } : {}),
    }];
  });
  if (phases.length === 0) return undefined;
  const title = readTrimmedString(rawPlan.title);
  return {
    ...(title ? { title } : {}),
    phases,
  };
}

export function extractActivity(parsed: Record<string, unknown>): ToolActivity | undefined {
  const raw = parsed._activity;
  if (!isRecord(raw)) return undefined;
  const nestedAction = extractActivityAction(raw.action);
  const legacyAction = extractActivityAction(raw);
  const action = nestedAction || legacyAction;
  const phase = extractActivityPhase(raw.phase);
  const plan = extractActivityPlan(raw.plan);
  if (!action && !plan) return undefined;
  return {
    ...(action ? action : {}),
    ...(phase ? { phase } : {}),
    ...(nestedAction ? { action: nestedAction } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function tokenizeShellPrefix(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"'|;&<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

export function wrapPowerShellCommand(command: string): string {
  return [
    "[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "$PSStyle.OutputRendering='PlainText'",
    command,
  ].join("; ");
}

export function findPowerShellExecutable(): string | null {
  return resolveExecutableOnPath("pwsh") || resolveExecutableOnPath("powershell.exe") || resolveExecutableOnPath("powershell");
}

export function buildPowerShellCommand(command: string): string[] {
  const executable = findPowerShellExecutable();
  if (!executable) throw new Error("PowerShell is not available on this machine.");
  return [
    executable,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    wrapPowerShellCommand(command),
  ];
}

export function buildBashCommand(command: string): string[] {
  const executable = resolveExecutableOnPath("bash") || resolveExecutableOnPath("sh");
  if (!executable) throw new Error("bash/sh is not available on this machine.");
  return [executable, "-lc", command];
}

export function buildWorkspaceShellCommand(args: {
  toolName: string;
  command: string;
  shell?: unknown;
}): string[] {
  if (args.shell === "powershell") return buildPowerShellCommand(args.command);
  if (args.shell === "bash") return buildBashCommand(args.command);
  return process.platform === "win32"
    ? buildPowerShellCommand(args.command)
    : buildBashCommand(args.command);
}

export function findWorkspaceShellEscapeToken(command: string): string | null {
  const tokens = tokenizeShellPrefix(command);
  for (const token of tokens) {
    if (
      token === ".." ||
      token.startsWith("../") ||
      token.startsWith("..\\") ||
      token.includes("/../") ||
      token.includes("\\..\\")
    ) {
      return token;
    }
    if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
      return token;
    }
    if (
      token === "/" ||
      token.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(token) ||
      token.startsWith("\\\\")
    ) {
      return token;
    }
  }
  return null;
}

export function buildWorkspaceShellEscapeBlockedResult(args: {
  command: string;
  token: string;
}): AgentRuntimeToolResult {
  return {
    content: [
      "workspace_shell_escape_blocked",
      `blockedToken: ${args.token}`,
      `command: ${args.command}`,
      "Use paths relative to the authorized folder only.",
      "exitCode: 126",
    ].join("\n"),
    metadata: {
      exitCode: 126,
      workspaceShellEscapeBlocked: true,
      blockedToken: args.token,
    },
  };
}

export function extractInteractiveGhAuthCommand(command: string): string | null {
  const tokens = tokenizeShellPrefix(command);
  if (tokens[0] !== "gh" || tokens[1] !== "auth") return null;
  const subcommand = tokens[2];
  if (subcommand !== "login" && subcommand !== "refresh") return null;
  if (tokens.includes("--help")) return null;

  const result = ["gh", "auth", subcommand];
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "-h" || token === "--hostname" || token === "-s" || token === "--scopes" || token === "--remove-scopes" || token === "-r") {
      const value = tokens[index + 1];
      if (value) {
        result.push(token, value);
        index += 1;
      }
      continue;
    }
    if (token === "--clipboard" || token === "-c" || token === "--insecure-storage" || token === "--reset-scopes") {
      result.push(token);
      continue;
    }
    if (token.startsWith("--hostname=") || token.startsWith("--scopes=") || token.startsWith("--remove-scopes=")) {
      result.push(token);
      continue;
    }
  }
  return result.join(" ");
}

export function buildInteractiveCommandBlockedResult(command: string): AgentRuntimeToolResult {
  const argv = tokenizeShellPrefix(command);
  return {
    content: [
      "action_gate: handoff",
      `command: ${command}`,
      "Run this in the current TUI terminal, then resume the agent turn.",
      "exitCode: 130",
    ].join("\n"),
    metadata: {
      exitCode: 130,
      timedOut: false,
      actionGate: {
        id: `gate-${Date.now().toString(36)}-terminal-handoff`,
        kind: "handoff",
        title: "This command requires an interactive terminal.",
        body: "Complete it in the terminal, then nolo will continue.",
        payload: {
          command: argv,
          displayCommand: command,
        },
      },
      reason: "interactive-command-requires-terminal",
    },
  };
}

export function resolveExecShellTimeoutMs(override: number | undefined): number | undefined {
  const fromOverride = asOptionalPositiveFiniteNumber(override);
  if (fromOverride !== undefined) return fromOverride;
  const raw = process.env[EXEC_SHELL_TIMEOUT_ENV];
  if (raw === undefined) return undefined;
  return asOptionalPositiveFiniteNumber(Number(raw));
}

/** Always returns a concrete threshold: override >= 0 (0 = detach immediately,
 * the smart-detach path) wins, otherwise env NOLO_EXEC_SHELL_DETACH_MS,
 * otherwise the default. */
export function resolveDetachMs(override: number | undefined): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return override;
  }
  const raw = process.env[EXEC_SHELL_DETACH_ENV];
  if (raw === undefined) return DEFAULT_EXEC_SHELL_DETACH_MS;
  const parsed = asOptionalPositiveFiniteNumber(Number(raw));
  return parsed === undefined ? DEFAULT_EXEC_SHELL_DETACH_MS : parsed;
}

export function truncateToolOutput(value: string, limit = 20_000): string {
  if (value.length <= limit) return value;
  const approxMarkerLen = 40;
  if (limit <= approxMarkerLen) return value.slice(0, limit);
  const remaining = limit - approxMarkerLen;
  const headSize = Math.floor(remaining * 0.3);
  const tailSize = remaining - headSize;
  const head = value.slice(0, headSize);
  const tail = value.slice(-tailSize);
  const actualRemoved = value.length - headSize - tailSize;
  return `${head}\n\n[... truncated ${actualRemoved} chars ...]\n\n${tail}`;
}

export function readNodeStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise<string>((resolveStream, rejectStream) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", rejectStream);
    stream.on("end", () => {
      resolveStream(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function waitForNodeProcessExit(proc: ReturnType<typeof spawnChildProcess>): Promise<number> {
  return new Promise<number>((resolveExit, rejectExit) => {
    proc.on("error", rejectExit);
    proc.on("close", (code) => {
      resolveExit(code ?? 0);
    });
  });
}

export function deriveLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "process";
  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? trimmed;
  const labelCandidate = lastToken.split(/[/\\]/).pop() || lastToken;
  return labelCandidate || trimmed;
}

export function isSpawnFailureError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") return true;
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("enoent")
    || message.includes("executable not found")
    || (message.includes("spawn") && message.includes("not found"))
  );
}

export function spawnFailedCommandResult(error: unknown, outputLimit?: number) {
  const stderr = `spawn failed: ${toErrorMessage(error)}\n`;
  return {
    stdout: "",
    stderr,
    exitCode: 127,
    timedOut: false as const,
    spawnFailed: true as const,
    content: truncateToolOutput(
      [`stderr:\n${stderr.trim()}`, "exitCode: 127"].filter(Boolean).join("\n\n"),
      outputLimit,
    ),
  };
}

export type WorkspaceExecResult =
  | {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: false;
      spawnFailed: true;
      content: string;
      aborted?: undefined;
      detached?: undefined;
      pid?: undefined;
      label?: undefined;
    }
  | {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: false;
      detached: true;
      pid: number;
      label: string;
      content: string;
      spawnFailed?: undefined;
      aborted?: undefined;
    }
  | {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
      aborted: boolean;
      content: string;
      spawnFailed?: undefined;
      detached?: undefined;
      pid?: undefined;
      label?: undefined;
    };

export async function runWorkspaceCommand(args: {
  workspaceRoot: string;
  command: string[];
  stdin?: string;
  timeoutMs?: number;
  outputLimit?: number;
  commandPrefix?: string[];
  abortSignal?: AbortSignal;
  detachMs?: number;
}): Promise<WorkspaceExecResult> {
  const timeoutMs = asOptionalPositiveFiniteNumber(args.timeoutMs);
  const detached = process.platform !== "win32";
  const command = [
    ...(args.commandPrefix ?? []),
    ...args.command,
  ];
  const proc = spawnChildProcess(command[0] ?? "", command.slice(1), {
    cwd: resolve(args.workspaceRoot),
    stdio: [
      args.stdin === undefined ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ],
    detached,
  });
  if (args.stdin !== undefined && proc.stdin) {
    proc.stdin.write(args.stdin);
    proc.stdin.end();
  }
  const exitPromise = waitForNodeProcessExit(proc);
  const cleanupChildOnHostSignal = (signal: NodeJS.Signals) => {
    if (typeof proc.pid === "number") {
      try { process.kill(-proc.pid, signal); } catch { /* already exited */ }
    }
  };
  if (detached) {
    process.once("SIGHUP", cleanupChildOnHostSignal);
    process.once("SIGTERM", cleanupChildOnHostSignal);
    process.once("SIGINT", cleanupChildOnHostSignal);
  }
  const detachSignalCleanup = () => {
    if (!detached) return;
    process.removeListener("SIGHUP", cleanupChildOnHostSignal);
    process.removeListener("SIGTERM", cleanupChildOnHostSignal);
    process.removeListener("SIGINT", cleanupChildOnHostSignal);
  };
  exitPromise.then(detachSignalCleanup, detachSignalCleanup);
  const stdoutPromise = readNodeStream(proc.stdout);
  const stderrPromise = readNodeStream(proc.stderr);
  const killChild = (signal: NodeJS.Signals) => {
    if (detached && typeof proc.pid === "number") {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch {
        // Fall through to killing the immediate child.
      }
    }
    try {
      proc.kill(signal);
    } catch {
      // The command may have exited after the race winner was decided.
    }
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let detachTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = Symbol("timeout");
  const abortResult = Symbol("abort");
  const detachResult = Symbol("detach");

  let abortListener: (() => void) | undefined;
  const abortPromise = args.abortSignal
    ? new Promise<typeof abortResult>((resolveAbort) => {
        if (args.abortSignal!.aborted) {
          resolveAbort(abortResult);
          return;
        }
        abortListener = () => resolveAbort(abortResult);
        args.abortSignal!.addEventListener("abort", abortListener, { once: true });
      })
    : null;

  const effectiveDetachMs = resolveDetachMs(args.detachMs);
  const detachPromise = new Promise<typeof detachResult>((resolveDetach) => {
    detachTimer = setTimeout(() => resolveDetach(detachResult), effectiveDetachMs);
  });

  const exitOrTimeoutPromise = timeoutMs
    ? Promise.race([
        exitPromise,
        new Promise<typeof timeoutResult>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(timeoutResult), timeoutMs);
        }),
      ])
    : exitPromise;

  const raceCandidates: Promise<number | typeof timeoutResult | typeof abortResult | typeof detachResult>[] = [
    exitOrTimeoutPromise,
    detachPromise,
  ];
  if (abortPromise) {
    raceCandidates.push(abortPromise);
  }

  let raceWinner: number | typeof timeoutResult | typeof abortResult | typeof detachResult;
  try {
    raceWinner = await Promise.race(raceCandidates);
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (detachTimer) clearTimeout(detachTimer);
    if (abortListener && args.abortSignal) {
      args.abortSignal.removeEventListener("abort", abortListener);
    }
    if (isSpawnFailureError(error)) {
      return spawnFailedCommandResult(error, args.outputLimit);
    }
    throw error;
  }
  if (timeout) clearTimeout(timeout);
  if (detachTimer) clearTimeout(detachTimer);
  if (abortListener && args.abortSignal) {
    args.abortSignal.removeEventListener("abort", abortListener);
  }

  const timedOut = raceWinner === timeoutResult;
  const aborted = raceWinner === abortResult;
  const detachedProcess = raceWinner === detachResult;

  if (timedOut || aborted) {
    killChild("SIGTERM");
    const forceKillTimer = setTimeout(() => {
      killChild("SIGKILL");
    }, 500);
    try {
      await exitPromise;
    } catch {
      // The error is handled via the timedOut / aborted return shape.
    } finally {
      clearTimeout(forceKillTimer);
    }
  }

  if (detachedProcess) {
    exitPromise.catch(() => {});
    const pid = typeof proc.pid === "number" ? proc.pid : 0;
    const label = deriveLabel(args.command.join(" "));
    const pgid = pid;
    const registry = getProcessRegistry();
    registry.add({ pid, pgid, command: args.command.join(" "), label });
    proc.on("close", (code) => {
      detachSignalCleanup();
      registry.markExited(pid, code ?? 1);
    });
    const immediate = effectiveDetachMs === 0;
    const reason = immediate
      ? `command looks long-running; moved to background immediately (pid=${pid}, label=${label})`
      : `command detached to background after ${effectiveDetachMs}ms (pid=${pid}, label=${label})`;
    return {
      stdout: "",
      stderr: `${reason}\nUse listProcesses to inspect or stop it.`,
      exitCode: 0,
      timedOut: false,
      detached: true,
      pid,
      label,
      content: JSON.stringify({
        detached: true,
        pid,
        label,
        status: "running",
        ...(immediate ? { reason: "long-running-command" } : {}),
      }),
    };
  }

  const [stdout, rawStderr] = await Promise.all([
    stdoutPromise,
    stderrPromise,
  ]);
  const exitCode = aborted ? 130 : timedOut ? 124 : Number(raceWinner);
  const stderr = aborted
    ? `${rawStderr.trim() ? `${rawStderr.trim()}\n` : ""}command aborted by signal\n`
    : timedOut
      ? `${rawStderr.trim() ? `${rawStderr.trim()}\n` : ""}command timed out after ${timeoutMs ?? "unknown"}ms\n`
      : rawStderr;
  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    aborted,
    content: truncateToolOutput([
      stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
      stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      `exitCode: ${exitCode}`,
    ].filter(Boolean).join("\n\n"), args.outputLimit),
  };
}
