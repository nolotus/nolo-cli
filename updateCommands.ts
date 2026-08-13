import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeServerOrigin } from "./core/serverOrigin";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import { loadProfileConfig } from "./client/profileConfig";
import { resolveDefaultSpawn, type SpawnFn, type SpawnedProcess } from "./processSpawn";
import { isCompiledBinary } from "./cliEnvHelpers";

export type CliReleaseChannel = "alpha" | "latest";

type PackageInfo = {
  name: string;
  version: string;
};

export type CliInstallKind = "npm-global" | "standalone-bundle";

type DoctorInfo = {
  packageName: string;
  version: string;
  entrypoint: string;
  serverUrl: string;
  profileName: string;
  installKind: CliInstallKind;
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

export function renderProgressBar(percent: number, width = 30): string {
  const pct = Math.max(0, Math.min(100, percent));
  const filledLen = Math.round((width * pct) / 100);
  const emptyLen = width - filledLen;
  const bar = "#".repeat(filledLen) + " ".repeat(emptyLen);
  const pctText = pct.toFixed(1).padStart(5, " ");
  return `[${bar}] ${pctText}%`;
}

export function buildNpmSelfUpdateCommand(channel: CliReleaseChannel = "latest") {
  return ["npm", "install", "-g", `nolo-cli@${channel}`, "--force", "--progress"];
}

/**
 * Resolve the tarball name + extract subdir for the current host platform.
 * Mirrors install-nolo.sh's `uname -sm` case. Returns null on unsupported
 * platforms so the caller can fall back to the npm path or error out.
 */
export function resolveStandaloneBundlePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { tarballName: string; extractSubdir: string } | null {
  if (platform === "linux" && arch === "x64") {
    return { tarballName: "nolo-linux-x64.tar.gz", extractSubdir: "nolo-linux-x64" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { tarballName: "nolo-darwin-arm64.tar.gz", extractSubdir: "nolo-darwin-arm64" };
  }
  return null;
}

/**
 * Pick the tarball download base for a release channel. alpha pulls from
 * us.nolo.chat (where new bundles land first), latest pulls from nolo.chat.
 * Mirrors install-nolo.sh's NOLO_INSTALL_REPO default.
 */
export function resolveStandaloneBundleRepoBase(channel: CliReleaseChannel): string {
  return channel === "alpha" ? "https://us.nolo.chat" : "https://nolo.chat";
}

/**
 * Build the manual-update hint shown by `nolo doctor`. For standalone-bundle
 * installs this points at the install.sh curl pipe instead of npm.
 */
export function buildStandaloneManualUpdateHint(channel: CliReleaseChannel): string {
  const repoBase = resolveStandaloneBundleRepoBase(channel);
  return `curl -fsSL ${repoBase}/install-nolo.sh | sh`;
}

/**
 * Resolve the install directory for the standalone binary symlink. Mirrors
 * install-nolo.sh's install_dir(): prefer /usr/local/bin if writable, else
 * ~/.local/bin, else ~/.nolo/bin. We cannot use dirname(process.execPath)
 * because in a Bun --compile binary process.execPath resolves the symlink to
 * the real binary under ~/.nolo/<platform>/, not the symlink location on PATH.
 */
function resolveStandaloneInstallDir(): string {
  const candidates = [
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    join(homedir(), ".nolo/bin"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      accessSync(dir, constants.W_OK);
      return dir;
    } catch {
      // exists but not writable — try next candidate (matches install.sh -w)
      continue;
    }
  }
  // Last resort: ~/.nolo/bin (install.sh creates it if missing).
  return join(homedir(), ".nolo/bin");
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
    `Manual update: ${info.installKind === "standalone-bundle" ? buildStandaloneManualUpdateHint(info.updateChannel) : buildNpmSelfUpdateCommand(info.updateChannel).join(" ")}`,
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

/**
 * Run a self-spawned shell command and forward its stdout/stderr into the
 * given output stream. Returns the process exit code. Mirrors the spawn
 * plumbing used by the npm path so update output is visible in both the
 * TUI sink and inherited-stdio production mode.
 */
async function runShellScript(
  script: string,
  {
    output,
    spawn,
    env,
    cwd,
    useCustomSink,
  }: {
    output: NodeJS.WritableStream;
    spawn: SpawnFn;
    env: NodeJS.ProcessEnv;
    cwd?: string;
    useCustomSink: boolean;
  },
): Promise<number> {
  const proc: SpawnedProcess = spawn({
    cmd: ["sh", "-c", script],
    cwd,
    stdin: "inherit",
    stdout: useCustomSink ? "pipe" : "inherit",
    stderr: useCustomSink ? "pipe" : "inherit",
    env,
  });

  if (!useCustomSink) {
    return proc.exited;
  }

  const [exitCode] = await Promise.all([
    proc.exited,
    forwardSpawnOutput(proc.stdout, output),
    forwardSpawnOutput(proc.stderr, output),
  ]);
  return exitCode;
}

/**
 * Update a standalone-bundle install (Bun `--compile` binary installed via
 * install-nolo.sh) by re-running the same curl+tar+symlink flow as the
 * installer. No npm/bun package manager involved — the bundle is a
 * self-contained binary fetched from the download host.
 *
 * Mirrors install-nolo.sh: download tarball → extract to ~/.nolo/<platform>/
 * → atomically swap the symlink in the install dir.
 */
export async function runStandaloneBundleUpdate(
  options: RunSelfUpdateOptions,
): Promise<number> {
  const output = options.output ?? process.stdout;
  const spawn: SpawnFn = options.spawn ?? resolveDefaultSpawn();
  const env = options.env ?? process.env;
  const serverUrl = resolveSelfUpdateServerUrl(env, options.serverUrl);
  const channel = getCliInstallChannel(serverUrl);

  const platform = resolveStandaloneBundlePlatform();
  if (!platform) {
    output.write(
      `✗ Standalone-bundle self-update is not supported on this platform\n` +
      `  (platform=${process.platform}, arch=${process.arch}).\n` +
      `  Only linux-x64 and darwin-arm64 bundles are published.\n` +
      `  Falling back is not possible from a compiled binary; reinstall via:\n` +
      `    ${buildStandaloneManualUpdateHint(channel)}\n`,
    );
    return 1;
  }

  const { tarballName, extractSubdir } = platform;
  const repoBase = resolveStandaloneBundleRepoBase(channel);
  const tarballUrl = `${repoBase}/public/downloads/${tarballName}`;
  const fallbackUrl = `https://nolo.chat/public/downloads/${tarballName}`;

  const extractDir = join(homedir(), ".nolo", extractSubdir);
  const installDir = resolveStandaloneInstallDir();
  const symlinkPath = join(installDir, "nolo");

  // Single self-contained shell script that mirrors install-nolo.sh's main():
  // temp dir + trap cleanup, curl with fallback, tar extract, atomic symlink
  // swap. Run as one sh -c so the trap + set -e semantics match the installer.
  const script = `set -euo pipefail
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Downloading nolo from ${tarballUrl}..."
if ! curl -fL --progress-bar "${tarballUrl}" -o "$TEMP_DIR/${tarballName}"; then
  ${
    tarballUrl !== fallbackUrl
      ? `echo "Primary source unavailable, trying ${fallbackUrl}..."
  if ! curl -fL --progress-bar "${fallbackUrl}" -o "$TEMP_DIR/${tarballName}"; then
    echo "Error: download failed from ${fallbackUrl}" >&2
    exit 1
  fi`
      : `echo "Error: download failed from ${tarballUrl}" >&2
  exit 1`
  }
fi

mkdir -p "${extractDir}"
tar -xzf "$TEMP_DIR/${tarballName}" -C "${extractDir}"
chmod +x "${extractDir}/nolo"

mkdir -p "${installDir}"
if [ -e "${symlinkPath}" ] || [ -L "${symlinkPath}" ]; then
  rm -f "${symlinkPath}"
fi
ln -s "${extractDir}/nolo" "${symlinkPath}"
trap - EXIT

echo "nolo updated to ${installDir}/nolo"
`;

  output.write(`\nNolo Agent CLI Installer & Updater\n`);
  output.write(`-----------------------------------------\n`);
  output.write(`✓ Target channel: ${channel} (standalone bundle)\n`);
  output.write(`▸ Downloading and installing bundle...\n`);

  const useCustomSink = options.output !== undefined;
  const exitCode = await runShellScript(script, {
    output,
    spawn,
    env,
    useCustomSink,
  });

  if (exitCode === 0) {
    output.write(`  ${renderProgressBar(100.0)}\n`);
    output.write(`✓ Update completed successfully!\n\n`);
  }

  return exitCode;
}

// ─── Update availability check ─────────────────────────────────────────────
// AI-assisted development ships new CLI versions constantly (alpha channel
// pushes a release on every merge), so the TUI welcome page nudges users to
// upgrade when the npm dist-tag for their channel is ahead of the installed
// version. The check is best-effort: any failure (offline, registry hiccup,
// malformed payload) resolves to null so the TUI stays silent rather than
// nagging on flaky networks.

export type CliUpdateInfo = {
  latestVersion: string;
  channel: CliReleaseChannel;
};

/** Set NOLO_CLI_NO_UPDATE_CHECK=1 to disable the startup update check. */
export const NOLO_UPDATE_CHECK_KILL_SWITCH = "NOLO_CLI_NO_UPDATE_CHECK";

type ParsedVersion = { main: number[]; pre: string[] };

function parseCliVersion(raw: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Compare two CLI versions ("0.24.0", "0.24.0-alpha.5") as semver-ish,
 * returning -1 / 0 / 1. Pre-release suffixes sort below the release they
 * prefix ("0.24.0-alpha.5" < "0.24.0"), matching npm dist-tag semantics so
 * the alpha channel can still surface a newer alpha.
 */
export function compareCliVersions(a: string, b: string): number {
  const pa = parseCliVersion(a);
  const pb = parseCliVersion(b);
  // Malformed input falls back to lexicographic order instead of NaN poison.
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x) ? Number(x) : NaN;
    const yn = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) return xn < yn ? -1 : 1;
    if (!Number.isNaN(xn)) return -1; // numeric identifiers sort below alphanumeric
    if (!Number.isNaN(yn)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export type CliUpdateCheckOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Best-effort check against the npm registry for a newer `nolo-cli` on the
 * channel implied by the server origin (us.nolo.chat → alpha, else latest).
 * Resolves to null when there is no newer version or the check cannot
 * complete — callers must treat null as "no prompt".
 */
export async function checkForCliUpdate(
  currentVersion: string | undefined,
  serverUrl?: string | null,
  options: CliUpdateCheckOptions = {},
): Promise<CliUpdateInfo | null> {
  const env = options.env ?? process.env;
  // per-key fallback 与 refreshGitStatus 的 kill switch 一致：显式 env 缺键时
  // 仍尊重进程级开关（workspace 测试常传 env: {}）。
  if (
    (env[NOLO_UPDATE_CHECK_KILL_SWITCH] ?? process.env[NOLO_UPDATE_CHECK_KILL_SWITCH]) === "1"
  ) {
    return null;
  }
  // 当前版本缺失或不可解析（本地开发/未知安装）时不提示，避免误报。
  if (!currentVersion || !parseCliVersion(currentVersion)) return null;

  const channel = getCliInstallChannel(serverUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;

  try {
    const res = await fetchImpl(
      `https://registry.npmjs.org/nolo-cli/${channel}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const latestVersion = data.version;
    // 两侧版本都必须可解析才比较：registry 返回非法版本（或恶意 payload）
    // 时不得进入字典序 fallback，否则可能把垃圾字符串当成"更新版本"误报。
    if (
      !latestVersion ||
      !parseCliVersion(latestVersion) ||
      compareCliVersions(latestVersion, currentVersion) <= 0
    ) {
      return null;
    }
    return { latestVersion, channel };
  } catch {
    // Offline / timeout / malformed payload: stay silent, never nag.
    return null;
  }
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

  // Standalone-bundle installs (Bun --compile binary via install-nolo.sh) take
  // a different update path: re-fetch the platform tarball and swap the
  // symlink, no npm/bun package manager involved. Route before touching npm
  // so sh-installed users without npm get a working `nolo update`.
  if (isCompiledBinary()) {
    return runStandaloneBundleUpdate(options);
  }

  const output = options.output ?? process.stdout;
  const spawn: SpawnFn = options.spawn ?? resolveDefaultSpawn();
  const env = options.env ?? process.env;
  const serverUrl = resolveSelfUpdateServerUrl(env, options.serverUrl);

  const channel = getCliInstallChannel(serverUrl);
  const command = buildNpmSelfUpdateCommand(channel);

  output.write(`\nNolo Agent CLI Installer & Updater\n`);
  output.write(`-----------------------------------------\n`);
  output.write(`✓ Target channel: ${channel} (nolo-cli@${channel})\n`);
  output.write(`▸ Downloading and installing package via npm...\n`);

  const useCustomSink = options.output !== undefined;
  const proc: SpawnedProcess = spawn({
    cmd: command,
    stdin: "inherit",
    stdout: useCustomSink ? "pipe" : "inherit",
    stderr: useCustomSink ? "pipe" : "inherit",
    env,
  });

  if (!useCustomSink) {
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      output.write(`  ${renderProgressBar(100.0)}\n`);
      output.write(`✓ Update completed successfully!\n\n`);
    }
    return exitCode;
  }

  const [exitCode] = await Promise.all([
    proc.exited,
    forwardSpawnOutput(proc.stdout, output),
    forwardSpawnOutput(proc.stderr, output),
  ]);

  if (exitCode === 0) {
    output.write(`  ${renderProgressBar(100.0)}\n`);
    output.write(`✓ Update completed successfully!\n\n`);
  }

  return exitCode;
}