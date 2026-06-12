import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageInfo = {
  name: string;
  version: string;
};

type DoctorInfo = {
  packageName: string;
  version: string;
  entrypoint: string;
  serverUrl: string;
  profileName: string;
};

type RunSelfUpdateOptions = {
  output?: NodeJS.WritableStream;
  spawn?: typeof Bun.spawn;
};

type SpawnOutputChunk = string | ArrayBuffer | ArrayBufferView;

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(CLI_DIR, "package.json");

export function readPackageInfo(): PackageInfo {
  const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<PackageInfo>;
  return {
    name: parsed.name || "nolo-cli",
    version: parsed.version || "0.0.0",
  };
}

export function buildCliVersionText(info: PackageInfo) {
  return `${info.name} ${info.version}`;
}

export function buildSelfUpdateCommand() {
  return ["npm", "install", "-g", "nolo-cli@latest", "--force"];
}

export function buildCliDoctorText(info: DoctorInfo) {
  const updateCommand = buildSelfUpdateCommand().join(" ");
  return [
    "Nolo CLI doctor",
    "---------------",
    `version  ${info.packageName} ${info.version}`,
    `entry    ${info.entrypoint}`,
    `server   ${info.serverUrl}`,
    `profile  ${info.profileName}`,
    `update   nolo update`,
    "",
    "If direct `nolo` differs from repo-local `bun ./packages/cli/index.ts`,",
    "the global npm install is older than this checkout.",
    "",
    `Manual update: ${updateCommand}`,
  ].join("\n");
}

function isRunSelfUpdateOptions(
  value: NodeJS.WritableStream | RunSelfUpdateOptions
): value is RunSelfUpdateOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    ("output" in value || "spawn" in value)
  );
}

async function forwardSpawnOutput(
  stream: AsyncIterable<SpawnOutputChunk> | undefined,
  output: NodeJS.WritableStream
) {
  if (!stream) {
    return;
  }

  for await (const chunk of stream) {
    output.write(normalizeSpawnChunk(chunk));
  }
}

function normalizeSpawnChunk(
  chunk: SpawnOutputChunk
): string | Uint8Array<ArrayBufferLike> {
  if (typeof chunk === "string" || chunk instanceof Uint8Array) {
    return chunk;
  }

  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }

  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export async function runSelfUpdate(
  outputOrOptions?: NodeJS.WritableStream | RunSelfUpdateOptions
) {
  const options =
    outputOrOptions === undefined
      ? {}
      : isRunSelfUpdateOptions(outputOrOptions)
        ? outputOrOptions
        : { output: outputOrOptions };
  const output = options.output ?? process.stdout;
  const spawn = options.spawn ?? Bun.spawn;
  const command = buildSelfUpdateCommand();
  output.write(`Updating nolo with: ${command.join(" ")}\n`);

  const useCustomSink = options.output !== undefined;
  const proc = spawn({
    cmd: command,
    stdin: "inherit",
    stdout: useCustomSink ? "pipe" : "inherit",
    stderr: useCustomSink ? "pipe" : "inherit",
    env: process.env,
  });

  if (!useCustomSink) {
    return await proc.exited;
  }

  const [exitCode] = await Promise.all([
    proc.exited,
    forwardSpawnOutput(proc.stdout, output),
    forwardSpawnOutput(proc.stderr, output),
  ]);

  return exitCode;
}
