import { execSync } from "node:child_process";

export type GitStatus = {
  branch: string;
  modified: number;
  untracked: number;
};

export function detectGitStatus(cwd: string): GitStatus | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!branch) return undefined;

    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!status) {
      return { branch, modified: 0, untracked: 0 };
    }

    let modified = 0;
    let untracked = 0;
    for (const line of status.split("\n")) {
      if (!line) continue;
      const flag = line[0];
      if (flag === "?") untracked += 1;
      else modified += 1;
    }

    return { branch, modified, untracked };
  } catch {
    return undefined;
  }
}
