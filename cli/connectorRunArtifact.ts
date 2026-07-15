import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { clipMultilineText } from "../core/clipMultilineText";
import { toErrorMessage } from "../core/errorMessage";
import type { MachineRunPermissionPolicy } from "../ai/agent/machineRunPermissions";
import { readPipeText, spawnProcess } from "./processSpawn";

type EnvLike = Record<string, string | undefined>;

export type ConnectorRunArtifact = {
  cwd: string;
  exitStatus: "completed" | "failed";
  collectedAt: string;
  baseSha?: string | null;
  headSha?: string | null;
  changedFiles?: string[];
  statusShort?: string;
  diffStat?: string;
  patchPreview?: string;
  error?: string;
  artifactError?: string;
};

const MAX_PATCH_PREVIEW_CHARS = 24_000;

function normalizePath(value: string) {
  return resolve(value.trim());
}

export function resolveConnectorRunCwd(args: {
  env?: EnvLike;
  policy: MachineRunPermissionPolicy;
  fallbackCwd?: string;
}) {
  const explicit =
    args.env?.NOLO_CONNECTOR_WORKDIR ||
    args.env?.NOLO_AGENT_WORKDIR ||
    "";
  const candidate = explicit || args.policy.writableRoots[0] || args.fallbackCwd || process.cwd();
  const cwd = normalizePath(candidate);
  if (!existsSync(cwd)) {
    throw new Error(`Connector run cwd does not exist: ${cwd}`);
  }
  return cwd;
}

async function runGit(
  args: string[],
  cwd: string,
  options: { trim?: boolean } = {}
): Promise<string | null> {
  const proc = spawnProcess({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([
    readPipeText(proc.stdout),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;
  return options.trim === false ? stdout.replace(/\r?\n$/, "") : stdout.trim();
}

export function parseStatusChangedFiles(statusShort: string | null): string[] {
  if (!statusShort) return [];
  return [...new Set(statusShort
    .split(/\r?\n/)
    .map((line) => {
      const porcelainMatch = line.match(/^.{2} (.+)$/);
      if (porcelainMatch?.[1]) return porcelainMatch[1].trim();
      const trimmedMatch = line.match(/^[MADRCU?!]{1,2}\s+(.+)$/);
      return trimmedMatch?.[1]?.trim() ?? "";
    })
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) ?? line : line)
    .filter(Boolean))];
}

export async function readConnectorGitHead(cwd: string): Promise<string | null> {
  return runGit(["rev-parse", "HEAD"], cwd);
}

export async function collectConnectorRunArtifact(args: {
  cwd: string;
  baseSha?: string | null;
  exitStatus: "completed" | "failed";
  error?: string;
}): Promise<ConnectorRunArtifact> {
  const collectedAt = new Date().toISOString();
  try {
    const [headSha, statusShort, diffStat, patchText] = await Promise.all([
      readConnectorGitHead(args.cwd),
      runGit(["status", "--short"], args.cwd, { trim: false }),
      runGit(["diff", "--stat"], args.cwd),
      runGit(["diff", "--no-color", "--unified=3"], args.cwd),
    ]);
    const patchPreview = patchText
      ? clipMultilineText(patchText, MAX_PATCH_PREVIEW_CHARS) || undefined
      : undefined;
    return {
      cwd: args.cwd,
      exitStatus: args.exitStatus,
      collectedAt,
      baseSha: args.baseSha ?? null,
      headSha,
      changedFiles: parseStatusChangedFiles(statusShort),
      ...(statusShort ? { statusShort } : {}),
      ...(diffStat ? { diffStat } : {}),
      ...(patchPreview ? { patchPreview } : {}),
      ...(args.error ? { error: args.error } : {}),
    };
  } catch (error) {
    return {
      cwd: args.cwd,
      exitStatus: args.exitStatus,
      collectedAt,
      baseSha: args.baseSha ?? null,
      ...(args.error ? { error: args.error } : {}),
      artifactError: toErrorMessage(error),
    };
  }
}
