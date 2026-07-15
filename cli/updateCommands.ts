import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeServerOrigin } from "../core/serverOrigin";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import { loadProfileConfig } from "./client/profileConfig";
import { resolveDefaultSpawn, type SpawnFn, type SpawnedProcess } from "./processSpawn";
import { isCompiledBinary } from "./cliEnvHelpers";

export type CliReleaseChannel = "alpha" | "latest";

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
  installKind: "npm-global";
  updateChannel: CliReleaseChannel;
};

type RunSelfUpdateOptions = {
  output?: NodeJS.WritableStream;
  spawn?: SpawnFn;
  entrypointPath?: string;
  serverUrl?: string;
  env?: NodeJS.ProcessEnv;
};

type SpawnOutputChunk = string | ArrayBuffer | ArrayBufferView;

function resolvePackageJsonPath(): string | null {
  if (isCompiledBinary()) {
    // In a Bun-compiled binary, import.meta.url points into a virtual
    // bunfs root. Look for a package.json next to the real executable,
    // which native packages ship alongside the binary.
    const execDir = dirname(process.execPath);
    const candidate = join(execDir, "package.json");
    if (existsSync(candidate)) return candidate;
    return null;
  }
  const CLI_DIR = dirname(fileURLToPath(import.meta.url));
  const candidate = join(CLI_DIR, "package.json");
  return existsSync(candidate) ? candidate : null;
}

const PACKAGE_JSON_PATH = resolvePackageJsonPath();

export function getCliInstallChannel(serverUrl?: string | null): CliReleaseChannel {
  const normalized = normalizeServerOrigin(serverUrl);
  if (!normalized) {
    return "latest";
  }
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    if (hostname === "us.nolo.chat" || hostname.endsWith(".us.nolo.chat")) {
      return "alpha";
    }
  } catch {
    if (/us\.nolo\.chat/i.test(normalized)) {
      return "alpha";
    }
  }
  return "latest";
}

export function buildNpmSelfUpdateCommand(channel: CliReleaseChannel = "latest") {
  return ["npm", "install", "-g", `nolo-cli@${channel}`, "--force"];
}

export function readPackageInfo(): PackageInfo {
  if (PACKAGE_JSON_PATH) {
    try {
      const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<PackageInfo>;
      return {
        name: parsed.name || "nolo-cli",
        version: parsed.version || "0.0.0",
      };
    } catch {
      // Fall through to env defaults.
    }
  }
  return {
    name: process.env.NOLO_CLI_PACKAGE_NAME || "nolo-cli",
    version: process.env.NOLO_CLI_VERSION || "0.0.0",
  };
}

export function buildCliVersionText(info: PackageInfo) {
  return `${info.name} ${info.version}`;
}

export function buildSelfUpdateCommand(serverUrl?: string | null) {
  return buildNpmSelfUpdateCommand(getCliInstallChannel(serverUrl));
}

export function resolveSelfUpdateServerUrl(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
) {
  if (override?.trim()) {
    return normalizeServerOrigin(override);
  }
  const fromEnv = env.NOLO_SERVER || env.BASE_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return normalizeServerOrigin(fromEnv);
  }
  const profile = loadProfileConfig();
  const profileUrl = profile?.profiles?.[profile.currentProfile]?.serverUrl;
  if (profileUrl?.trim()) {
    return normalizeServerOrigin(profileUrl);
  }
  return DEFAULT_NOLO_SERVER_URL;
}

export function buildCliDoctorText(info: DoctorInfo) {
  return [
    "Nolo CLI doctor",
    "---------------",
    `version  ${info.packageName} ${info.version}`,
    `install  ${info.installKind}`,
    `channel  ${info.updateChannel}`,
    `entry    ${info.entrypoint}`,
    `server   ${info.serverUrl}`,
    `profile  ${info.profileName}`,
    `update   nolo update`,
    "",
    "If direct `nolo` differs from repo-local `bun ./packages/cli/index.ts`,",
    "the global install is older than this checkout.",
    "",
    `Manual update: ${buildNpmSelfUpdateCommand(info.updateChannel).join(" ")}`,
  ].join("\n");
}

function isRunSelfUpdateOptions(
  value: NodeJS.WritableStream | RunSelfUpdateOptions,
): value is RunSelfUpdateOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    ("output" in value ||
      "spawn" in value ||
      "entrypointPath" in value ||
      "serverUrl" in value ||
      "env" in value)
  );
}

async function forwardSpawnOutput(
  stream: AsyncIterable<SpawnOutputChunk> | null | undefined,
  output: NodeJS.WritableStream,
) {
  if (!stream) {
    return;
  }

  for await (const chunk of stream) {
    output.write(normalizeSpawnChunk(chunk));
  }
}

function normalizeSpawnChunk(
  chunk: SpawnOutputChunk,
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
  outputOrOptions?: NodeJS.WritableStream | RunSelfUpdateOptions,
) {
  const options =
    outputOrOptions === undefined
      ? {}
      : isRunSelfUpdateOptions(outputOrOptions)
        ? outputOrOptions
        : { output: outputOrOptions };
  const output = options.output ?? process.stdout;
  const spawn: SpawnFn = options.spawn ?? resolveDefaultSpawn();
  const env = options.env ?? process.env;
  const serverUrl = resolveSelfUpdateServerUrl(env, options.serverUrl);

  const command = buildNpmSelfUpdateCommand(getCliInstallChannel(serverUrl));
  output.write(`Updating nolo with: ${command.join(" ")}\n`);

  const useCustomSink = options.output !== undefined;
  const proc: SpawnedProcess = spawn({
    cmd: command,
    stdin: "inherit",
    stdout: useCustomSink ? "pipe" : "inherit",
    stderr: useCustomSink ? "pipe" : "inherit",
    env,
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