import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import { runAgentTurn, type RunAgentTurnResult, type TaskRowContext } from "./client/agentRun";
import type { AgentRuntimeHostAdapter, AgentRuntimeRequestedMode } from "./agentRuntimeLocal";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parseSkillDocProtocol, type WorkflowReferenceConfig } from "../ai/skills/skillDocProtocol";
import { LOCAL_CODEX_AGENT_KEY, isLocalCliAgentKey, resolveCliAgentKeyInput } from "./agentAliases";
import { resolveAgentInput } from "./agentNameResolver";
import type { CliKvDb } from "./client/hybridRecordStore";

type EnvLike = Record<string, string | undefined>;

type OutputLike = {
  write(chunk: string): unknown;
};

type AgentRunCommandDeps = {
  env?: EnvLike;
  scriptDir: string;
  output?: OutputLike;
  commandPath?: string[];
  runner?: typeof runAgentTurn;
  localRuntimeAdapterFactory?: (env: EnvLike, options?: { cwd?: string }) => AgentRuntimeHostAdapter;
  inspectLocalRunWorkspace?: typeof inspectLocalRunWorkspace;
  resolveWorkflowReference?: typeof resolveWorkflowReference;
  db?: CliKvDb;
  fetchImpl?: typeof fetch;
  fallbackFetchImpl?: typeof fetch;
};

type LocalRunWorkspaceInspection = {
  cwd: string;
  clean: boolean;
  status: string;
  commit?: {
    hash: string;
    subject: string;
  };
};

type ParseAgentRunArgsOptions = {
  readTextFile?: (path: string) => string;
  commandPath?: string[];
};

type ParsedAgentRunArgs = {
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
  subjectDialogKey?: string;
  subjectRefs?: Array<{ kind: string; id: string; role?: string }>;
  background: boolean;
  noStream: boolean;
  cwd?: string;
  timeoutMs?: number;
  traceTools: boolean;
  eventsMode?: "jsonl";
  injectFeatureWorktreeInstruction: boolean;
  taskRowContext?: TaskRowContext;
  workflowRef?: string;
};

type ResolvedWorkflowReference = {
  ref: string;
  content: string;
  config?: Partial<WorkflowReferenceConfig>;
};

function readFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function readRepeatedFlagValues(args: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function runtimeModeFromArgs(args: string[]): AgentRuntimeRequestedMode | undefined {
  if (args.includes("--local")) return "local";
  if (args.includes("--server")) return "server";
  if (args.includes("--auto")) return "auto";
  return undefined;
}

function isMonthlyMimoAgentRef(raw: string | undefined, resolved: string) {
  void raw;
  void resolved;
  return false;
}

function parsePositiveInteger(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseSubjectRef(raw: string): { kind: string; id: string; role?: string } | null {
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

function positionalArgs(args: string[]) {
  const values: string[] = [];
  const valuelessFlags = new Set([
    "--local",
    "--server",
    "--auto",
    "--dangerously-allow-shell",
    "--trace-tools",
    "--bg",
    "--no-stream",
    "--debug",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valuelessFlags.has(arg)) continue;
    if (arg.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
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
  const cwd = readFlagValue(args, "--cwd");
  const timeoutMs = parsePositiveInteger(readFlagValue(args, "--timeout-ms"));
  const rawEventsMode = readFlagValue(args, "--events");
  const eventsMode = rawEventsMode === "jsonl" ? "jsonl" : undefined;
  const inheritedRef = inheritedFromDialog
    ? parseDialogReference(inheritedFromDialog)
    : undefined;
  const imageUrls = [
    ...readRepeatedFlagValues(args, "--image"),
    ...readRepeatedFlagValues(args, "--image-url"),
  ];
  const mimoLocalWorkspaceDefault =
    isMonthlyMimoAgentRef(rawAgentKey, agentKey) && runtimeMode !== "server";
  const explicitLocalCliAgentDefault =
    isLocalCliAgentKey(agentKey) && runtimeMode !== "server";
  const workflowRef = readFlagValue(args, "--workflow");
  const taskRowDbKey = readFlagValue(args, "--task-row-dbkey");
  const artifactIds = readFlagValue(args, "--artifact-ids")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    agentKey,
    message,
    imageUrls,
    allowShell: args.includes("--dangerously-allow-shell") || mimoLocalWorkspaceDefault || explicitLocalCliAgentDefault,
    traceTools: args.includes("--trace-tools"),
    ...(eventsMode ? { eventsMode } : {}),
    injectFeatureWorktreeInstruction: mimoLocalWorkspaceDefault,
    ...(workflowRef ? { workflowRef } : {}),
    ...(taskRowDbKey
      ? {
          taskRowContext: {
            rowDbKey: taskRowDbKey,
            ...(artifactIds?.length ? { artifactIds } : {}),
          },
        }
      : {}),
    ...(runtimeMode
      ? { runtimeMode }
      : mimoLocalWorkspaceDefault || explicitLocalCliAgentDefault || args.includes("--dangerously-allow-shell")
        ? { runtimeMode: "local" as const }
        : {}),
    background: args.includes("--bg"),
    noStream: args.includes("--no-stream"),
    ...(continueDialogId ? { continueDialogId } : {}),
    ...(!continueDialogId && spaceId ? { spaceId } : {}),
    ...(category ? { category } : {}),
    ...(inheritedRef?.dialogKey ? { inheritedFromDialogKey: inheritedRef.dialogKey } : {}),
    ...(inheritedRef?.dialogId ? { parentDialogId: inheritedRef.dialogId } : {}),
    ...(subjectDialogKey ? { subjectDialogKey } : {}),
    ...(subjectRefs.length ? { subjectRefs } : {}),
    ...(cwd ? { cwd } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function workflowRefToCandidatePath(cwd: string, ref: string) {
  const normalized = ref.trim();
  if (!normalized) return "";
  if (normalized.endsWith(".md") || normalized.includes("/") || normalized.includes("\\")) {
    const directPath = resolve(cwd, normalized);
    if (existsSync(directPath)) return directPath;
  }
  const fileName = normalized.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
  return resolve(cwd, "docs", "workflows", `${fileName}.md`);
}

export async function resolveWorkflowReference(ref: string, cwd = process.cwd()): Promise<ResolvedWorkflowReference> {
  const path = workflowRefToCandidatePath(cwd, ref);
  if (!path || !existsSync(path)) {
    throw new Error(`Workflow reference not found: ${ref}`);
  }
  const markdown = readFileSync(path, "utf8");
  const parsed = parseSkillDocProtocol(markdown);
  return {
    ref,
    content: parsed.content,
    ...(parsed.meta?.workflowConfig ? { config: parsed.meta.workflowConfig } : {}),
  };
}

export function prependWorkflowReferencePrompt(message: string, workflow?: ResolvedWorkflowReference): string {
  if (!workflow) return message;
  const config = workflow.config;
  return [
    "AI-native workflow reference:",
    "- This reference is guidance for the agent, not a central workflow engine.",
    `- ref: ${workflow.ref}`,
    ...(config?.id ? [`- id: ${config.id}`] : []),
    ...(config?.name ? [`- name: ${config.name}`] : []),
    ...(config?.defaultAgent ? [`- suggested defaultAgent: ${config.defaultAgent}`] : []),
    ...(config?.inputs?.length ? [`- inputs: ${config.inputs.join(", ")}`] : []),
    ...(config?.recommendedTools?.length ? [`- recommendedTools: ${config.recommendedTools.join(", ")}`] : []),
    ...(config?.requiredTools?.length ? [`- requiredTools: ${config.requiredTools.join(", ")}`] : []),
    ...(config?.requiredOutputs?.length ? [`- requiredOutputs: ${config.requiredOutputs.join(", ")}`] : []),
    ...(config?.gates?.length ? [`- gates: ${config.gates.join(", ")}`] : []),
    ...(config?.contextStrategy ? [`- contextStrategy: ${config.contextStrategy}`] : []),
    ...(config?.failureProtocol ? [`- failureProtocol: ${config.failureProtocol}`] : []),
    "",
    "Reference body:",
    workflow.content,
    "",
    "User task:",
    message,
  ].join("\n");
}

function prependFeatureWorktreeInstruction(message: string, enabled: boolean) {
  if (!enabled) return message;
  return [
    "Local execution rule:",
    "- You are running in the current git checkout with shell access.",
    "- For read-only checks, smoke tests, or answering questions, stay in the current directory.",
    "- Before developing a new feature or making non-trivial code changes, create a separate git worktree yourself with git worktree and do the edits there.",
    "- Commit and push only when the user explicitly asks or the task requires it.",
    "",
    "User task:",
    message,
  ].join("\n");
}

export function prependSubjectDialogMarker(
  message: string,
  subjectDialogKey: string | undefined
) {
  if (!subjectDialogKey) return message;
  return [
    `Subject dialog for this run: ${subjectDialogKey}`,
    "If the user asks to evaluate the referenced dialog, call readDialog with this id/key first.",
    "",
    message,
  ].join("\n");
}

function parseDialogReference(rawInput: string) {
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

function mimeTypeForPath(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

export function normalizeCliImageInput(input: string) {
  if (/^(https?:|data:|file:)/i.test(input)) return input;
  const absolutePath = resolve(input);
  if (!existsSync(absolutePath)) return input;
  const base64 = readFileSync(absolutePath).toString("base64");
  return `data:${mimeTypeForPath(absolutePath)};base64,${base64}`;
}

async function runGitForLocalSummary(args: {
  cwd: string;
  gitArgs: string[];
}) {
  const proc = Bun.spawn(["git", ...args.gitArgs], {
    cwd: args.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `git ${args.gitArgs.join(" ")} failed`).trim());
  }
  return stdout.trim();
}

async function inspectLocalRunWorkspace(cwd: string): Promise<LocalRunWorkspaceInspection> {
  const status = await runGitForLocalSummary({
    cwd,
    gitArgs: ["status", "--short"],
  });
  const rawCommit = await runGitForLocalSummary({
    cwd,
    gitArgs: ["log", "-1", "--format=%h%x00%s"],
  }).catch(() => "");
  const [hash, subject] = rawCommit.split("\0");
  return {
    cwd,
    clean: status.trim() === "",
    status,
    ...(hash ? { commit: { hash, subject: subject ?? "" } } : {}),
  };
}

function shouldPrintLocalRunSummary(args: {
  parsed: ParsedAgentRunArgs;
  localRuntimeCwd?: string;
}) {
  return Boolean(args.localRuntimeCwd && args.parsed.runtimeMode === "local");
}

function formatLocalRunSummary(args: {
  dialogId?: string;
  inspection: LocalRunWorkspaceInspection;
}) {
  return [
    "",
    "[nolo] local run summary",
    `workspace: ${args.inspection.cwd}`,
    ...(args.dialogId ? [`dialog: ${args.dialogId}`] : []),
    ...(args.inspection.commit
      ? [`commit: ${args.inspection.commit.hash} ${args.inspection.commit.subject}`]
      : []),
    `dirty: ${args.inspection.clean ? "clean" : "dirty"}`,
    ...(!args.inspection.clean && args.inspection.status.trim()
      ? [`status:\n${args.inspection.status.trim()}`]
      : []),
    "",
  ].join("\n");
}

function resolveServerUrl(env: EnvLike) {
  return (env.NOLO_SERVER || env.BASE_URL || DEFAULT_NOLO_SERVER_URL).replace(/\/+$/, "");
}

function buildLocalRunEnv(args: {
  env: EnvLike;
  allowShell: boolean;
}) {
  void args.allowShell;
  return {
    ...args.env,
  };
}

function writeUsage(output: OutputLike, commandPath?: string[]) {
  const commandName = commandPath?.join(" ");
  if (commandName === "run") {
    output.write(
      "Usage: nolo run <message> [--cwd <path>] [--events jsonl]\n" +
        "       nolo run --msg <message> [--cwd <path>] [--image <url-or-path>]\n" +
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
      "       nolo agent run --agent <agent> (--msg <message>|--msg-file <path>) [--image <url-or-path>] [--space <spaceId>] [--category <name>] [--inherit-from-dialog <dialog>] [--subject-dialog <dialog>] [--subject-ref <kind:id[:role]>] [--task-row-dbkey <key>] [--bg] [--timeout-ms <n>] [--events jsonl] [--no-stream]\n"
  );
}

export async function runAgentRunCommand(args: string[], deps: AgentRunCommandDeps) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const parsed = parseAgentRunArgs(args, { commandPath: deps.commandPath });
  if (!parsed) {
    writeUsage(output, deps.commandPath);
    return 1;
  }

  const runner = deps.runner ?? runAgentTurn;
  let runnerAgentName = parsed.agentKey;
  try {
    const resolvedAgent = await resolveAgentInput({
      agentInput: parsed.agentKey,
      env,
      db: deps.db,
      fetchImpl: deps.fetchImpl ?? fetch,
      fallbackFetchImpl: deps.fallbackFetchImpl,
      output,
    });
    parsed.agentKey = resolvedAgent.agentKey;
    runnerAgentName = resolvedAgent.agentName;
  } catch (error) {
    output.write(`[nolo] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let workflowReference: ResolvedWorkflowReference | undefined;
  if (parsed.workflowRef) {
    try {
      workflowReference = await (deps.resolveWorkflowReference ?? resolveWorkflowReference)(
        parsed.workflowRef
      );
    } catch (error) {
      output.write(`[nolo] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  let localRuntimeCwd = parsed.cwd;
  if (!localRuntimeCwd && parsed.runtimeMode === "local") {
    localRuntimeCwd = process.cwd();
  }
  const runEnv = buildLocalRunEnv({
    env,
    allowShell: parsed.allowShell,
  });
  const result: RunAgentTurnResult = await runner({
    agentName: runnerAgentName,
    agentKey: parsed.agentKey,
    serverUrl: resolveServerUrl(env),
    message: prependWorkflowReferencePrompt(
      prependSubjectDialogMarker(
        prependFeatureWorktreeInstruction(
          parsed.message,
          parsed.injectFeatureWorktreeInstruction
        ),
        parsed.subjectDialogKey
      ),
      workflowReference
    ),
    imageUrls: parsed.imageUrls.map(normalizeCliImageInput),
    scriptDir: deps.scriptDir,
    env: runEnv,
    output,
    ...(deps.localRuntimeAdapterFactory
      ? { localRuntimeAdapterFactory: deps.localRuntimeAdapterFactory }
      : {}),
    ...(localRuntimeCwd ? { localRuntimeCwd } : {}),
    ...(parsed.runtimeMode ? { runtimeMode: parsed.runtimeMode } : {}),
    ...(parsed.continueDialogId ? { continueDialogId: parsed.continueDialogId } : {}),
    ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}),
    ...(parsed.category ? { category: parsed.category } : {}),
    ...(parsed.inheritedFromDialogKey ? { inheritedFromDialogKey: parsed.inheritedFromDialogKey } : {}),
    ...(parsed.parentDialogId ? { parentDialogId: parsed.parentDialogId } : {}),
    ...(parsed.subjectDialogKey ? { subjectDialogKey: parsed.subjectDialogKey } : {}),
    ...(parsed.subjectRefs?.length ? { subjectRefs: parsed.subjectRefs } : {}),
    background: parsed.background,
    noStream: parsed.noStream,
    ...(typeof parsed.timeoutMs === "number" ? { timeoutMs: parsed.timeoutMs } : {}),
    traceTools: parsed.traceTools,
    ...(parsed.eventsMode ? { eventsMode: parsed.eventsMode } : {}),
    ...(parsed.taskRowContext ? { taskRowContext: parsed.taskRowContext } : {}),
  });

  if (result.dialogId) {
    if (parsed.background) {
      output.write(`\n[nolo] background dialog ${result.dialogId}\n`);
      output.write(`[nolo] read: nolo dialog read ${result.dialogId}\n`);
    } else {
      output.write(`\n[nolo] dialog ${result.dialogId}\n`);
    }
  }
  if (shouldPrintLocalRunSummary({ parsed, localRuntimeCwd })) {
    try {
      const inspect = deps.inspectLocalRunWorkspace ?? inspectLocalRunWorkspace;
      const inspection = await inspect(localRuntimeCwd!);
      output.write(formatLocalRunSummary({
        dialogId: result.dialogId,
        inspection,
      }));
    } catch (error) {
      output.write(
        `\n[nolo] local run summary unavailable: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  return result.exitCode;
}
