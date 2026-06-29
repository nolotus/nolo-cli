// Local workspace inspection helpers for `nolo agent run`. Extracted from
// agentRunCommand.ts.

import { readPipeText, spawnProcess } from "./processSpawn";

type ParsedAgentRunArgsLike = {
  runtimeMode?: string;
  cwd?: string;
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

type InspectLocalRunWorkspaceDeps = {
  spawnProcess?: typeof spawnProcess;
  readPipeText?: typeof readPipeText;
};

async function runGitForLocalSummary(
  args: { cwd: string; gitArgs: string[] },
  deps: InspectLocalRunWorkspaceDeps = {}
) {
  const spawn = deps.spawnProcess ?? spawnProcess;
  const read = deps.readPipeText ?? readPipeText;
  const proc = spawn({
    cmd: ["git", ...args.gitArgs],
    cwd: args.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout),
    read(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `git ${args.gitArgs.join(" ")} failed`).trim());
  }
  return stdout.trim();
}

export async function inspectLocalRunWorkspace(
  cwd: string,
  deps: InspectLocalRunWorkspaceDeps = {}
): Promise<LocalRunWorkspaceInspection> {
  const run = (gitArgs: string[]) => runGitForLocalSummary({ cwd, gitArgs }, deps);
  const status = await run(["status", "--short"]);
  const rawCommit = await run(["log", "-1", "--format=%h%x00%s"]).catch(() => "");
  const [hash, subject] = rawCommit.split("\0");
  return {
    cwd,
    clean: status.trim() === "",
    status,
    ...(hash ? { commit: { hash, subject: subject ?? "" } } : {}),
  };
}

export function shouldPrintLocalRunSummary(args: {
  parsed: ParsedAgentRunArgsLike;
  localRuntimeCwd?: string;
}) {
  return Boolean(args.localRuntimeCwd && args.parsed.runtimeMode === "local");
}

export function formatLocalRunSummary(args: {
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

export type { LocalRunWorkspaceInspection };
