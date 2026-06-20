import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type SpawnStdio = "inherit" | "pipe" | "ignore";

export type SpawnProcessOptions = {
  cmd: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: SpawnStdio;
  stdout?: SpawnStdio;
  stderr?: SpawnStdio;
};

export type SpawnedProcess = {
  exited: Promise<number>;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
};

export type SpawnFn = (options: SpawnProcessOptions) => SpawnedProcess;

export function spawnProcess(options: SpawnProcessOptions): SpawnedProcess {
  const [command, ...args] = options.cmd;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [
        options.stdin ?? "pipe",
        options.stdout ?? "pipe",
        options.stderr ?? "pipe",
      ],
    });
  } catch {
    return {
      exited: Promise.resolve(127),
      stdin: null,
      stdout: null,
      stderr: null,
    };
  }

  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });

  return {
    exited,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

export async function readPipeText(stream: Readable | null): Promise<string> {
  if (!stream) return "";
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

export function resolveDefaultSpawn(): SpawnFn {
  const bunSpawn = (globalThis as { Bun?: { spawn?: unknown } }).Bun?.spawn;
  if (typeof bunSpawn === "function") {
    return bunSpawn as unknown as SpawnFn;
  }
  return spawnProcess;
}
