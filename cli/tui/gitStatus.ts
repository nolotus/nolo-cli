import { execFile, execSync } from "node:child_process";

export type GitStatus = {
  branch: string;
  modified: number;
  untracked: number;
};

function parseStatusOutput(branch: string, status: string): GitStatus {
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
}

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

    return parseStatusOutput(branch, status);
  } catch {
    return undefined;
  }
}

function execFileUtf8(
  file: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, encoding: "utf8", timeout: 2000 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
      },
    );
  });
}

export function detectGitStatusAsync(
  cwd: string,
): Promise<GitStatus | undefined> {
  return (async () => {
    try {
      const branch = (await execFileUtf8("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      if (!branch) return undefined;

      const status = (
        await execFileUtf8("git", ["status", "--porcelain"], cwd)
      ).trim();

      return parseStatusOutput(branch, status);
    } catch {
      return undefined;
    }
  })();
}
