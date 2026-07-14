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
  // Bun.spawn pipes are async iterables / web streams without setEncoding.
  const anyStream = stream as any;
  if (typeof anyStream.setEncoding !== "function" && typeof anyStream[Symbol.asyncIterator] === "function") {
    const chunks: string[] = [];
    for await (const chunk of anyStream as AsyncIterable<unknown>) {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString("utf8"));
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString("utf8"));
      else chunks.push(String(chunk ?? ""));
    }
    return chunks.join("");
  }
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    if (typeof anyStream.setEncoding === "function") {
      anyStream.setEncoding("utf8");
    }
    stream.on("data", (chunk: string | Buffer) => {
      data += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
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
