import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const IS_WINDOWS = process.platform === "win32";

function isExecutableFile(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a binary on PATH, then fall back to common install locations.
 * Desktop app launches often strip Homebrew from PATH (`/opt/homebrew/bin/rg`).
 */
export function resolveExecutableOnPath(name: string): string | null {
  if (IS_WINDOWS && !/\.[a-z]+$/i.test(name)) {
    const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT")
      .split(";")
      .filter(Boolean);
    for (const ext of exts) {
      const found = resolveExecutableOnPath(name + ext);
      if (found) return found;
    }
    return null;
  }

  const pathEnv = process.env.PATH ?? "";
  const sep = pathEnv.includes(";") && IS_WINDOWS ? ";" : ":";
  const pathDirs = pathEnv.split(sep).filter(Boolean);
  const fallbackDirs = IS_WINDOWS
    ? []
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        `${process.env.HOME ?? ""}/.local/bin`,
      ].filter(Boolean);

  for (const dir of [...pathDirs, ...fallbackDirs]) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

type GlobCompat = {
  match(path: string): boolean;
  scanSync(opts: { cwd: string; dot?: boolean; onlyFiles?: boolean }): string[];
};

export function createGlob(pattern: string): GlobCompat {
  const regex = globToRegExp(pattern);
  return {
    match(path: string) {
      return regex.test(path);
    },
    scanSync(opts) {
      const dot = opts.dot ?? false;
      const results: string[] = [];
      walkDir(opts.cwd, "", dot, results);
      return results.filter((rel) => regex.test(rel));
    },
  };
}

function walkDir(dir: string, prefix: string, dot: boolean, out: string[]) {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    // Force string Dirent names (Node overloads can infer NonSharedBuffer).
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }) as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (!dot && name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      walkDir(full, rel, dot, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  const trailingDir = pattern.endsWith("/");
  const src = trailingDir ? pattern.slice(0, -1) : pattern;
  const anchored = src.startsWith("/");
  const body = anchored ? src.slice(1) : src;

  let regex = "^";
  if (!anchored) regex += "(?:.*/)?";
  regex += convertBody(body);
  if (trailingDir) {
    regex += "(?:/.*)?";
  }
  regex += "$";
  return new RegExp(regex);
}

function convertBody(p: string): string {
  let out = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i += 2;
        if (p[i] === "/") {
          out += "(?:.*/)?";
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "[") {
      out += "[";
      i += 1;
      if (p[i] === "!") {
        out += "^";
        i += 1;
      }
      while (i < p.length && p[i] !== "]") {
        out += p[i] === "\\" ? "\\\\" : p[i];
        i += 1;
      }
      if (p[i] === "]") {
        out += "]";
        i += 1;
      }
    } else if (c === "{") {
      let depth = 1;
      let j = i + 1;
      let bodyStr = "";
      while (j < p.length && depth > 0) {
        if (p[j] === "{") depth += 1;
        else if (p[j] === "}") depth -= 1;
        if (depth > 0) bodyStr += p[j];
        j += 1;
      }
      const alts = bodyStr.split(",").map((alt) => convertBody(alt));
      out += `(?:${alts.join("|")})`;
      i = j;
    } else {
      out += escapeRegexChar(c);
      i += 1;
    }
  }
  return out;
}

function escapeRegexChar(c: string): string {
  if ("\\^$.|+()".includes(c)) {
    return `\\${c}`;
  }
  return c;
}

export type WebSpawnResult = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

export function spawnToWebStreams(options: {
  cmd: string[];
  env?: Record<string, string | undefined>;
}): WebSpawnResult {
  const [command, ...args] = options.cmd;
  const child = spawn(command, args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
  const toWeb = (stream: Readable | null): ReadableStream<Uint8Array> | null => {
    if (!stream) return null;
    return (stream as Readable & { toWeb?: () => ReadableStream<Uint8Array> }).toWeb?.()
      ?? new ReadableStream<Uint8Array>({
        start(controller) {
          stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          stream.on("end", () => controller.close());
          stream.on("error", (e) => controller.error(e));
        },
      });
  };
  return {
    stdout: toWeb(child.stdout),
    stderr: toWeb(child.stderr),
    exited,
  };
}
