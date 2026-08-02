import { describe, expect, test, mock, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realChildProcess from "node:child_process";

/**
 * detectGitStatus is the function the TUI status line relies on to show the
 * current branch and dirty file counts. The TUI now refreshes it after every
 * agent turn (see readlineWorkspace.ts exitOutputMode), so the function must
 * reflect on-disk reality at call time — not a cached snapshot.
 *
 * bun test's sandbox intercepts child_process stdout capture for tests under
 * packages/**, so we cannot shell out to a real git here. Instead we mock
 * execSync / execFile to feed porcelain output and assert the parsing contract
 * that the status line depends on. Spread the real module so unrelated exports
 * (spawn, etc.) keep working for later suites in the same process.
 */
describe("detectGitStatus", () => {
  afterEach(() => {
    mock.restore();
  });

  // Re-import with a mocked execSync per test so the module picks up the stub.
  async function importWithGit(
    branch: string,
    porcelain: string,
  ): Promise<typeof import("./gitStatus")> {
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      execSync: mock((cmd: string) => {
        if (cmd.includes("rev-parse")) return branch;
        if (cmd.includes("status --porcelain")) return porcelain;
        throw new Error(`unexpected cmd: ${cmd}`);
      }),
    }));
    return import("./gitStatus");
  }

  test("returns undefined when not on a branch (empty rev-parse)", async () => {
    const { detectGitStatus } = await importWithGit("", "");
    expect(detectGitStatus("/fake")).toBeUndefined();
  });

  test("clean tree: branch with 0 modified / 0 untracked", async () => {
    const { detectGitStatus } = await importWithGit("main\n", "");
    const result = detectGitStatus("/fake");
    expect(result).toEqual({ branch: "main", modified: 0, untracked: 0 });
  });

  test("counts modified vs untracked from porcelain output", async () => {
    // M  = staged modified, M = unstaged modified, ?? = untracked
    const porcelain = [
      "M  staged-mod.ts",
      " M unstaged-mod.ts",
      "?? new-file.ts",
      "?? another-new.ts",
    ].join("\n");
    const { detectGitStatus } = await importWithGit("feature\n", porcelain);
    const result = detectGitStatus("/fake");
    expect(result?.branch).toBe("feature");
    // First-column flag "??" → untracked; anything else → modified.
    expect(result?.modified).toBe(2);
    expect(result?.untracked).toBe(2);
  });

  test("catches execSync failure and returns undefined", async () => {
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      execSync: mock(() => {
        throw new Error("ENOENT");
      }),
    }));
    const { detectGitStatus } = await import("./gitStatus");
    expect(detectGitStatus("/nonexistent")).toBeUndefined();
  });

  test("returns undefined outside a git repo (real fs, no mock)", async () => {
    // Use the real module here — a fresh tmpdir has no .git, so rev-parse
    // fails and the catch returns undefined. This does not need stdout
    // capture to work; the failure path is what we are exercising.
    mock.restore();
    const { detectGitStatus } = await import("./gitStatus");
    const dir = await mkdtemp(join(tmpdir(), "nolo-git-"));
    try {
      expect(detectGitStatus(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectGitStatusAsync", () => {
  afterEach(() => {
    mock.restore();
  });

  async function importWithExecFile(
    branch: string,
    porcelain: string,
    opts?: { fail?: "rev-parse" | "status" | "all" },
  ): Promise<typeof import("./gitStatus")> {
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      execFile: mock(
        (
          _file: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          const joined = args.join(" ");
          if (opts?.fail === "all") {
            cb(new Error("ENOENT"), "", "");
            return;
          }
          if (joined.includes("rev-parse")) {
            if (opts?.fail === "rev-parse") {
              cb(new Error("not a git repo"), "", "");
              return;
            }
            cb(null, branch, "");
            return;
          }
          if (joined.includes("status") && joined.includes("--porcelain")) {
            if (opts?.fail === "status") {
              cb(new Error("status failed"), "", "");
              return;
            }
            cb(null, porcelain, "");
            return;
          }
          cb(new Error(`unexpected args: ${joined}`), "", "");
        },
      ),
    }));
    return import("./gitStatus");
  }

  test("async clean tree: branch with 0 modified / 0 untracked", async () => {
    const { detectGitStatusAsync } = await importWithExecFile("main\n", "");
    await expect(detectGitStatusAsync("/fake")).resolves.toEqual({
      branch: "main",
      modified: 0,
      untracked: 0,
    });
  });

  test("async counts modified vs untracked from porcelain output", async () => {
    const porcelain = [
      "M  staged-mod.ts",
      " M unstaged-mod.ts",
      "?? new-file.ts",
      "?? another-new.ts",
    ].join("\n");
    const { detectGitStatusAsync } = await importWithExecFile(
      "feature\n",
      porcelain,
    );
    const result = await detectGitStatusAsync("/fake");
    expect(result?.branch).toBe("feature");
    expect(result?.modified).toBe(2);
    expect(result?.untracked).toBe(2);
  });

  test("async returns undefined when rev-parse is empty", async () => {
    const { detectGitStatusAsync } = await importWithExecFile("", "");
    await expect(detectGitStatusAsync("/fake")).resolves.toBeUndefined();
  });

  test("async returns undefined on execFile failure", async () => {
    const { detectGitStatusAsync } = await importWithExecFile("main\n", "", {
      fail: "all",
    });
    await expect(detectGitStatusAsync("/fake")).resolves.toBeUndefined();
  });

  test("async returns undefined outside a git repo (real fs, no mock)", async () => {
    mock.restore();
    const { detectGitStatusAsync } = await import("./gitStatus");
    const dir = await mkdtemp(join(tmpdir(), "nolo-git-async-"));
    try {
      await expect(detectGitStatusAsync(dir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
