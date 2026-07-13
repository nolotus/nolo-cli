// Local background agent run control plane.
//
// Provides a small registry under ~/.nolo/runs/ and the commands that
// manage it: ps, status, logs, stop, kill. The registry is intentionally
// simple (one json file + one log file per run) so it can be inspected
// with ordinary shell tools.

import { homedir as nodeHomedir } from "node:os";
import { join } from "node:path";

import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as nodeFs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { isCompiledBinary, resolveCliEntrypointPath } from "./cliEnvHelpers";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

export type LocalAgentLoopEvent =
  | { kind: "llm-start"; round: number; atMs: number }
  | { kind: "llm-end"; round: number; atMs: number; ok: boolean }
  | { kind: "tool-start"; name: string; atMs: number }
  | { kind: "tool-end"; name: string; atMs: number; ok: boolean };

export type RunActivity = {
  lastEventAt: string;
  inFlight: { kind: "llm" | "tool"; name: string; sinceMs: number } | null;
  counters: { llmCalls: number; toolCalls: number; fileEdits: number };
  updatedAt: string;
};

export type RunRecord = {
  runId: string;
  pid?: number;
  agentKey: string;
  cwd?: string;
  msgFile?: string;
  startedAt: string;
  timeoutMs?: number;
  status: "running" | "done" | "failed" | "timeout" | "killed";
  exitCode?: number;
  endedAt?: string;
  logPath: string;
  dialogId?: string;
  note?: string;
  activity?: RunActivity;
};

export type FsLike = {
  mkdirSync: typeof nodeFs.mkdirSync;
  writeFileSync: typeof nodeFs.writeFileSync;
  readFileSync: typeof nodeFs.readFileSync;
  readdirSync: typeof nodeFs.readdirSync;
  existsSync: typeof nodeFs.existsSync;
  openSync: typeof nodeFs.openSync;
  unlinkSync: typeof nodeFs.unlinkSync;
};

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type KillLike = (pid: number, signal: string) => void;

export type SleepLike = (ms: number) => Promise<void>;
export type AgentRunControlDeps = {
  env?: EnvLike;
  homedir?: () => string;
  spawn?: SpawnLike;
  fs?: FsLike;
  kill?: KillLike;
  now?: () => Date;
  generateRunId?: () => string;
  sleep?: SleepLike;
  setSignalHandler?: (handler: () => void) => void;
  clearSignalHandler?: () => void;
};

export function resolveNoloHome(env?: EnvLike, homedir = nodeHomedir): string {
  const fromEnv = env?.NOLO_HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".nolo");
}

export function resolveRunsDir(env?: EnvLike, homedir = nodeHomedir): string {
  return join(resolveNoloHome(env, homedir), "runs");
}

export function resolveRunRecordPath(
  runId: string,
  env?: EnvLike,
  homedir = nodeHomedir
): string {
  return join(resolveRunsDir(env, homedir), `${runId}.json`);
}

export function resolveRunLogPath(
  runId: string,
  env?: EnvLike,
  homedir = nodeHomedir
): string {
  return join(resolveRunsDir(env, homedir), `${runId}.log`);
}

export function defaultGenerateRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${timestamp}-${random}`;
}

export function writeRunRecord(record: RunRecord, deps: AgentRunControlDeps = {}): void {
  const fs = deps.fs ?? nodeFs;
  const path = resolveRunRecordPath(record.runId, deps.env, deps.homedir);
  fs.mkdirSync(resolveRunsDir(deps.env, deps.homedir), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(record, null, 2));
}

const FILE_EDIT_TOOL_NAMES = new Set(["writeFile", "editFile"]);
const DEFAULT_ACTIVITY_WRITE_INTERVAL_MS = 2000;

type InFlightState = {
  kind: "llm" | "tool";
  name: string;
  startMs: number;
};

export type RunActivityTracker = {
  onLoopEvent: (event: LocalAgentLoopEvent) => void;
  getActivity: () => RunActivity;
  flush: () => void;
  dispose: () => void;
};

export function createRunActivityTracker(
  runId: string,
  deps: AgentRunControlDeps = {},
  options: { minWriteIntervalMs?: number } = {}
): RunActivityTracker {
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? (() => new Date());
  const minWriteIntervalMs =
    options.minWriteIntervalMs ?? DEFAULT_ACTIVITY_WRITE_INTERVAL_MS;

  let lastEventAt = now().toISOString();
  let inFlight: InFlightState | null = null;
  const counters = { llmCalls: 0, toolCalls: 0, fileEdits: 0 };
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastWriteAt = 0;

  function serializeActivity(): RunActivity {
    const nowDate = now();
    const nowMs = nowDate.getTime();
    return {
      lastEventAt,
      inFlight: inFlight
        ? {
            kind: inFlight.kind,
            name: inFlight.name,
            sinceMs: Math.max(0, nowMs - inFlight.startMs),
          }
        : null,
      counters: { ...counters },
      updatedAt: nowDate.toISOString(),
    };
  }

  function doWrite() {
    writeTimer = undefined;
    const record = readRunRecord(runId, deps);
    if (!record) return;
    const activity = serializeActivity();
    writeRunRecord({ ...record, activity }, deps);
    lastWriteAt = now().getTime();
  }

  function scheduleWrite() {
    if (writeTimer !== undefined) return;
    const elapsed = now().getTime() - lastWriteAt;
    const delay = Math.max(0, minWriteIntervalMs - elapsed);
    writeTimer = setTimeout(doWrite, delay);
  }

  function onLoopEvent(event: LocalAgentLoopEvent) {
    lastEventAt = new Date(event.atMs).toISOString();
    switch (event.kind) {
      case "llm-start":
        inFlight = { kind: "llm", name: "llm", startMs: event.atMs };
        break;
      case "llm-end":
        inFlight = null;
        counters.llmCalls += 1;
        break;
      case "tool-start":
        inFlight = { kind: "tool", name: event.name, startMs: event.atMs };
        break;
      case "tool-end":
        inFlight = null;
        counters.toolCalls += 1;
        if (FILE_EDIT_TOOL_NAMES.has(event.name)) {
          counters.fileEdits += 1;
        }
        break;
    }
    scheduleWrite();
  }

  function getActivity() {
    return serializeActivity();
  }

  function flush() {
    doWrite();
  }

  function dispose() {
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    }
  }

  return { onLoopEvent, getActivity, flush, dispose };
}

export function readRunRecord(runId: string, deps: AgentRunControlDeps = {}): RunRecord | null {
  const fs = deps.fs ?? nodeFs;
  const path = resolveRunRecordPath(runId, deps.env, deps.homedir);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export function listRunRecords(deps: AgentRunControlDeps = {}): RunRecord[] {
  const fs = deps.fs ?? nodeFs;
  const dir = resolveRunsDir(deps.env, deps.homedir);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    const record = readRunRecord(runId, deps);
    if (record) records.push(record);
  }
  return records.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export function findRunRecordByPid(
  pid: number,
  deps: AgentRunControlDeps = {}
): RunRecord | undefined {
  return listRunRecords(deps).find((record) => record.pid === pid);
}

export function findRunRecord(
  target: string,
  deps: AgentRunControlDeps = {}
): RunRecord | undefined {
  if (/^\d+$/.test(target)) {
    const pid = Number(target);
    const byPid = findRunRecordByPid(pid, deps);
    if (byPid) return byPid;
  }
  return readRunRecord(target, deps) ?? undefined;
}

export function stripBackgroundFlag(args: string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg === "--bg" || arg.startsWith("--bg=")) continue;
    result.push(arg);
  }
  return result;
}

function buildAgentRunChildCommand(options: {
  rawArgs: string[];
  commandPath?: string[];
  cliEntrypointPath?: string;
}): { execPath: string; childArgs: string[] } {
  const execPath = process.execPath;
  const entrypoint = options.cliEntrypointPath || resolveCliEntrypointPath();
  const commandParts = options.commandPath ?? [];
  const strippedArgs = stripBackgroundFlag(options.rawArgs);
  if (isCompiledBinary() || entrypoint === execPath) {
    return { execPath, childArgs: [...commandParts, ...strippedArgs] };
  }
  return { execPath, childArgs: [entrypoint, ...commandParts, ...strippedArgs] };
}

export async function spawnLocalBackgroundRun(
  input: {
    rawArgs: string[];
    commandPath?: string[];
    cliEntrypointPath?: string;
    agentKey: string;
    cwd?: string;
    msgFile?: string;
    timeoutMs?: number;
    output: OutputLike;
  },
  deps: AgentRunControlDeps = {}
): Promise<{ runId: string; pid?: number; logPath: string }> {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? nodeHomedir;
  const fs = deps.fs ?? nodeFs;
  const spawn = deps.spawn ?? nodeSpawn;
  const generateRunId = deps.generateRunId ?? defaultGenerateRunId;
  const now = deps.now ?? (() => new Date());

  const runId = generateRunId();
  const logPath = resolveRunLogPath(runId, env, homedir);
  const recordPath = resolveRunRecordPath(runId, env, homedir);
  const runsDir = resolveRunsDir(env, homedir);
  fs.mkdirSync(runsDir, { recursive: true });

  const record: RunRecord = {
    runId,
    agentKey: input.agentKey,
    cwd: input.cwd,
    ...(input.msgFile ? { msgFile: input.msgFile } : {}),
    startedAt: now().toISOString(),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    status: "running",
    logPath,
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

  const { execPath, childArgs } = buildAgentRunChildCommand({
    rawArgs: input.rawArgs,
    commandPath: input.commandPath,
    cliEntrypointPath: input.cliEntrypointPath,
  });

  const childEnv: EnvLike = {
    ...env,
    NOLO_AGENT_RUN_CHILD: "1",
    NOLO_AGENT_RUN_ID: runId,
  };

  const logFd = fs.openSync(logPath, "a");
  const proc = spawn(execPath, childArgs, {
    cwd: input.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  proc.unref();

  if (typeof proc.pid === "number") {
    record.pid = proc.pid;
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  }

  return { runId, pid: proc.pid, logPath };
}

export function finalizeRunRecord(
  runId: string,
  update: {
    status: RunRecord["status"];
    exitCode?: number;
    dialogId?: string;
    /** Diagnostic note for callers/logs; not persisted on the run record. */
    note?: string;
  },
  deps: AgentRunControlDeps = {}
): void {
  const record = readRunRecord(runId, deps);
  if (!record) return;
  const now = deps.now ?? (() => new Date());
  record.status = update.status;
  if (typeof update.exitCode === "number") record.exitCode = update.exitCode;
  if (update.dialogId) record.dialogId = update.dialogId;
  record.endedAt = now().toISOString();
  writeRunRecord(record, deps);
}

/**
 * Returns true when `pid` no longer exists, as reported by `kill(pid, 0)`
 * throwing ESRCH. Any other throw (e.g. EPERM, meaning the process still
 * exists but is owned by another user) is treated as "still running".
 */
export function isPidGone(pid: number, deps: AgentRunControlDeps = {}): boolean {
  const kill = deps.kill ?? ((p, s) => process.kill(p, s as NodeJS.Signals));
  try {
    kill(pid, "0");
    return false;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ESRCH";
  }
}

/**
 * If a run record claims to be running and carries a pid, verify the pid is
 * still alive via `kill(pid, 0)`. When the pid is gone (ESRCH), mark the
 * record as `failed` and record a note explaining the process disappeared.
 * Returns the (possibly refreshed) record.
 */
export function checkStaleRun(
  runId: string,
  deps: AgentRunControlDeps = {}
): RunRecord | null {
  const record = readRunRecord(runId, deps);
  if (!record) return null;
  if (record.status !== "running") return record;
  if (typeof record.pid !== "number") return record;
  if (!isPidGone(record.pid, deps)) return record;
  const now = deps.now ?? (() => new Date());
  record.status = "failed";
  record.note = "process gone: pid no longer exists";
  record.endedAt = now().toISOString();
  writeRunRecord(record, deps);
  return record;
}

function formatDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, end - start);
  const seconds = Math.floor(elapsedMs / 1000) % 60;
  const minutes = Math.floor(elapsedMs / 60000) % 60;
  const hours = Math.floor(elapsedMs / 3600000);
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function readLastLogLines(logPath: string, count: number, deps: AgentRunControlDeps): string[] {
  const fs = deps.fs ?? nodeFs;
  try {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } catch {
    return [];
  }
}

function readLogContent(logPath: string, tailCount: number | undefined, deps: AgentRunControlDeps): string {
  const fs = deps.fs ?? nodeFs;
  try {
    const content = fs.readFileSync(logPath, "utf8");
    if (typeof tailCount === "number" && tailCount > 0) {
      const lines = content.split("\n");
      // Drop trailing empty segment from final newline so slice counts real lines.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return `${lines.slice(-tailCount).join("\n")}\n`;
    }
    return content;
  } catch {
    return "";
  }
}

const RUNNING_STATUSES: ReadonlySet<RunRecord["status"]> = new Set(["running"]);

function isRunningStatus(status: RunRecord["status"]): boolean {
  return RUNNING_STATUSES.has(status);
}

function parseJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  let json = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--json=")) {
      const value = arg.slice("--json=".length);
      json = value === "" || value === "true" || value === "1";
      continue;
    }
    rest.push(arg);
  }
  return { json, rest };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAgentPsCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const { json } = parseJsonFlag(args);
  const records = listRunRecords(deps);
  // Apply stale-pid reconciliation for any running records that carry a pid.
  for (const record of records) {
    if (record.status === "running" && typeof record.pid === "number") {
      checkStaleRun(record.runId, deps);
    }
  }
  // Re-read after reconciliation so the printed/json state reflects any updates.
  const refreshed = records
    .map((r) => readRunRecord(r.runId, deps))
    .filter(Boolean) as RunRecord[];
  if (json) {
    deps.output.write(JSON.stringify(refreshed) + "\n");
    return 0;
  }
  if (refreshed.length === 0) {
    deps.output.write("No local runs found.\n");
    return 0;
  }
  deps.output.write("RUN ID                          STATUS   PID      AGENT\n");
  for (const record of refreshed) {
    const pid = record.pid?.toString() ?? "-";
    deps.output.write(
      `${record.runId.padEnd(32)} ${record.status.padEnd(8)} ${pid.padEnd(8)} ${record.agentKey}\n`
    );
  }
  return 0;
}

function parseStatusArgs(args: string[]): {
  target: string;
  json: boolean;
  watch: boolean;
  intervalMs: number;
} {
  let target = "";
  let json = false;
  let watch = false;
  let intervalMs = 2000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--json=")) {
      const value = arg.slice("--json=".length);
      json = value === "" || value === "true" || value === "1";
      continue;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg.startsWith("--watch=")) {
      const value = arg.slice("--watch=".length);
      watch = value === "" || value === "true" || value === "1";
      continue;
    }
    if (arg === "--interval-ms") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        intervalMs = Number(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--interval-ms=")) {
      const value = arg.slice("--interval-ms=".length);
      if (/^\d+$/.test(value)) intervalMs = Number(value);
      continue;
    }
    if (!arg.startsWith("-") && !target) {
      target = arg;
    }
  }
  return { target, json, watch, intervalMs };
}

function printStatusTick(record: RunRecord, deps: AgentRunControlDeps & { output: OutputLike }): void {
  const elapsed = formatDuration(record.startedAt, record.endedAt);
  const note = record.note ? ` (${record.note})` : "";
  deps.output.write(
    `[${new Date().toISOString()}] ${record.runId} status=${record.status} elapsed=${elapsed}${note}\n`
  );
}

export async function runAgentStatusCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const { target, json, watch, intervalMs } = parseStatusArgs(args);
  if (!target) {
    deps.output.write("Usage: nolo agent status <runId|pid> [--json] [--watch] [--interval-ms N]\n");
    return 1;
  }
  const initial = findRunRecord(target, deps);
  if (!initial) {
    deps.output.write(`Run not found: ${target}\n`);
    return 1;
  }

  // Reconcile stale pids before producing output.
  const reconciled = checkStaleRun(initial.runId, deps) ?? initial;

  if (json) {
    const record = readRunRecord(reconciled.runId, deps) ?? reconciled;
    deps.output.write(JSON.stringify(record) + "\n");
    return 0;
  }

  if (!watch) {
    const record = readRunRecord(reconciled.runId, deps) ?? reconciled;
    return printStatusOnce(record, deps);
  }

  return runStatusWatch(reconciled.runId, intervalMs, deps);
}

function formatActivitySummary(activity: RunActivity | undefined): string | undefined {
  if (!activity) return undefined;
  const { counters, inFlight, lastEventAt } = activity;
  const parts: string[] = [`${counters.fileEdits} edits, ${counters.toolCalls} tools`];
  if (inFlight) {
    const elapsedSec = Math.floor(
      (Date.now() - new Date(lastEventAt).getTime()) / 1000
    );
    parts.push(`in-flight ${inFlight.kind}${inFlight.name ? ` ${inFlight.name}` : ""} ${elapsedSec}s`);
  }
  return `activity: ${parts.join(", ")}`;
}

function printStatusOnce(record: RunRecord, deps: AgentRunControlDeps & { output: OutputLike }): number {
  deps.output.write(`runId:    ${record.runId}\n`);
  deps.output.write(`status:   ${record.status}\n`);
  deps.output.write(`pid:      ${record.pid ?? "-"}\n`);
  deps.output.write(`agent:    ${record.agentKey}\n`);
  deps.output.write(`cwd:      ${record.cwd ?? "-"}\n`);
  deps.output.write(`started:  ${record.startedAt}\n`);
  deps.output.write(`elapsed:  ${formatDuration(record.startedAt, record.endedAt)}\n`);
  if (record.endedAt) deps.output.write(`ended:    ${record.endedAt}\n`);
  if (typeof record.exitCode === "number") deps.output.write(`exitCode: ${record.exitCode}\n`);
  if (record.dialogId) deps.output.write(`dialog:   ${record.dialogId}\n`);
  if (record.note) deps.output.write(`note:     ${record.note}\n`);
  const activitySummary = formatActivitySummary(record.activity);
  if (activitySummary) deps.output.write(`${activitySummary}\n`);
  deps.output.write(`log:      ${record.logPath}\n`);

  const logLines = readLastLogLines(record.logPath, 20, deps);
  if (logLines.length > 0) {
    deps.output.write("\n--- last log lines ---\n");
    for (const line of logLines) {
      deps.output.write(`${line}\n`);
    }
  }
  return 0;
}

async function runStatusWatch(
  runId: string,
  intervalMs: number,
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  let stopped = false;
  const setSignalHandler = deps.setSignalHandler ?? ((handler: () => void) => {
    process.once("SIGINT" as NodeJS.Signals, handler);
  });
  const clearSignalHandler = deps.clearSignalHandler ?? (() => {
    process.removeAllListeners("SIGINT");
  });

  setSignalHandler(() => {
    stopped = true;
  });

  try {
    let record = readRunRecord(runId, deps);
    if (!record) {
      deps.output.write(`Run not found: ${runId}\n`);
      return 1;
    }
    // Initial tick.
    printStatusTick(record, deps);
    while (!stopped && isRunningStatus(record.status)) {
      await sleep(intervalMs);
      if (stopped) break;
      record = checkStaleRun(runId, deps);
      if (!record) {
        deps.output.write(`Run not found: ${runId}\n`);
        return 1;
      }
      printStatusTick(record, deps);
    }
    if (stopped) {
      deps.output.write(`watch stopped by signal\n`);
    }
    return 0;
  } finally {
    clearSignalHandler();
  }
}

function parseLogsArgs(
  args: string[],
  onTail: (count: number) => void
): string {
  let runId = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tail") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        onTail(Number(next));
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--tail=")) {
      const value = arg.slice("--tail=".length);
      if (/^\d+$/.test(value)) onTail(Number(value));
      continue;
    }
    if (!arg.startsWith("-") && !runId) {
      runId = arg;
    }
  }
  return runId;
}

export async function runAgentLogsCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  let tailCount: number | undefined;
  const runId = parseLogsArgs(args, (count) => {
    tailCount = count;
  });
  if (!runId) {
    deps.output.write("Usage: nolo agent logs <runId> [--tail N]\n");
    return 1;
  }
  const record = readRunRecord(runId, deps) ?? findRunRecordByPid(Number(runId), deps);
  if (!record) {
    deps.output.write(`Run not found: ${runId}\n`);
    return 1;
  }
  const fs = deps.fs ?? nodeFs;
  if (!fs.existsSync(record.logPath)) {
    deps.output.write(`Log not found: ${record.logPath}\n`);
    return 1;
  }
  const content = readLogContent(record.logPath, tailCount, deps);
  deps.output.write(content);
  return 0;
}

async function runSignalCommand(
  args: string[],
  signal: "SIGTERM" | "SIGKILL",
  verb: string,
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  const target = args[0];
  if (!target) {
    deps.output.write(`Usage: nolo agent ${verb} <runId|pid>\n`);
    return 1;
  }
  const record = findRunRecord(target, deps);
  if (!record) {
    deps.output.write(`Run not found: ${target}\n`);
    return 1;
  }
  if (typeof record.pid !== "number") {
    deps.output.write(`Run has no pid: ${record.runId}\n`);
    return 1;
  }
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig as NodeJS.Signals));
  try {
    kill(record.pid, signal);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") {
      deps.output.write(`Process ${record.pid} already exited.\n`);
    } else {
      deps.output.write(`Failed to ${verb} ${record.runId}: ${error}\n`);
      return 1;
    }
  }
  finalizeRunRecord(record.runId, { status: "killed" }, deps);
  deps.output.write(`Sent ${signal} to ${record.runId} (pid ${record.pid}).\n`);
  return 0;
}

export async function runAgentStopCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  return runSignalCommand(args, "SIGTERM", "stop", deps);
}

export async function runAgentKillCommand(
  args: string[],
  deps: AgentRunControlDeps & { output: OutputLike }
): Promise<number> {
  return runSignalCommand(args, "SIGKILL", "kill", deps);
}
