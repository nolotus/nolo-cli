import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDefaultSpawn, type SpawnFn } from "./processSpawn";

export type CliReleaseChannel = "alpha" | "latest";
export type CliBundlePlatform = "linux-x64" | "darwin-arm64" | "darwin-x64" | "win-x64";

export type StandaloneBundleManifest = {
  schemaVersion: number;
  name: string;
  version: string;
  channel: CliReleaseChannel;
  platform: CliBundlePlatform;
  bunVersion?: string;
  entrypoint?: string;
  bin?: Record<string, string>;
  buildHost?: {
    platform: string;
    arch: string;
    bunVersion?: string;
    builtAt?: string;
  };
  nativeDeps?: Record<string, unknown>;
};

export type StandaloneBundleInstall = {
  bundleRoot: string;
  cliDir: string;
  manifest: StandaloneBundleManifest;
};

export type PublishedStandaloneBundleManifest = {
  schemaVersion: number;
  channel: CliReleaseChannel;
  version: string;
  bunVersion?: string;
  platform: CliBundlePlatform;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
  publishedAt: string;
  buildHost?: {
    platform: string;
    arch: string;
    bunVersion?: string;
    builtAt?: string;
  };
  nativeDeps?: Record<string, unknown>;
};

const SUPPORTED_BUNDLE_SCHEMA_VERSIONS = [1, 2] as const;

const CLI_DOWNLOADS_SUBPATH = "cli";

export function getCliInstallChannel(serverUrl?: string | null): CliReleaseChannel {
  const normalized =
    typeof serverUrl === "string" ? serverUrl.trim().replace(/\/+$/, "") : "";
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

export function resolveBundleUpdateChannel(args: {
  install: StandaloneBundleInstall;
  serverUrl: string;
  output?: NodeJS.WritableStream;
}): CliReleaseChannel {
  const fromServer = getCliInstallChannel(args.serverUrl);
  const fromInstall = args.install.manifest.channel;
  if (fromInstall && fromInstall !== fromServer) {
    args.output?.write(
      `[nolo] Warning: server channel (${fromServer}) differs from installed bundle channel (${fromInstall}); using installed channel.\n`,
    );
    return fromInstall;
  }
  return fromServer;
}

export function resolveCliBundlePlatform(): CliBundlePlatform | null {
  const { platform, arch } = process;
  if (platform === "linux" && (arch === "x64" || arch === "amd64")) {
    return "linux-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "darwin" && (arch === "x64" || arch === "amd64")) {
    return "darwin-x64";
  }
  if (platform === "win32" && (arch === "x64" || arch === "amd64")) {
    return "win-x64";
  }
  return null;
}

export function detectStandaloneBundleInstall(
  entrypointPath?: string,
): StandaloneBundleInstall | null {
  const cliDir = entrypointPath
    ? entrypointPath.startsWith("file:")
      ? dirname(fileURLToPath(entrypointPath))
      : dirname(entrypointPath)
    : dirname(fileURLToPath(import.meta.url));
  const bundleRoot = join(cliDir, "..", "..");
  const manifestPath = join(bundleRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as StandaloneBundleManifest;
    if (
      manifest?.name !== "nolo-cli" ||
      !(SUPPORTED_BUNDLE_SCHEMA_VERSIONS as readonly number[]).includes(
        manifest?.schemaVersion,
      )
    ) {
      return null;
    }
    const entrypoint = join(cliDir, "index.js");
    if (!existsSync(entrypoint)) {
      return null;
    }
    return { bundleRoot, cliDir, manifest };
  } catch {
    return null;
  }
}

/**
 * Returns true if the manifest's recorded buildHost (where the bundle was
 * packed) is compatible with the current host's process.platform / process.arch.
 * Manifests without a buildHost (schemaVersion 1) are treated as compatible
 * to keep backward compatibility with bundles published before the v2
 * schema was introduced. New bundles (schemaVersion 2) MUST include
 * buildHost and the host MUST match the current runtime, otherwise the
 * download is refused because the native bindings in node_modules/ would
 * be for the wrong platform.
 */
export function isBundleHostCompatible(manifest: {
  schemaVersion?: number;
  buildHost?: { platform?: string; arch?: string };
}): boolean {
  if (manifest?.schemaVersion !== 2 || !manifest.buildHost) {
    return true;
  }
  const { platform, arch } = manifest.buildHost;
  if (!platform || !arch) return true;
  return platform === process.platform && arch === process.arch;
}

export function buildBundleManifestUrl(args: {
  serverUrl: string;
  channel: CliReleaseChannel;
  platform: CliBundlePlatform;
}) {
  const origin = args.serverUrl.trim().replace(/\/+$/, "");
  return `${origin}/public/downloads/${CLI_DOWNLOADS_SUBPATH}/nolo-cli-${args.channel}-${args.platform}-manifest.json`;
}

export function buildNpmSelfUpdateCommand(channel: CliReleaseChannel = "latest") {
  return ["npm", "install", "-g", `nolo-cli@${channel}`, "--force"];
}

export function validatePublishedBundleManifest(args: {
  published: PublishedStandaloneBundleManifest;
  expectedChannel: CliReleaseChannel;
  expectedPlatform: CliBundlePlatform;
}) {
  if (
    !(SUPPORTED_BUNDLE_SCHEMA_VERSIONS as readonly number[]).includes(
      args.published.schemaVersion,
    )
  ) {
    throw new Error(
      `Unsupported standalone bundle manifest schema: ${args.published.schemaVersion}`,
    );
  }
  if (args.published.channel !== args.expectedChannel) {
    throw new Error(
      `Standalone bundle manifest channel mismatch (expected ${args.expectedChannel}, got ${args.published.channel})`,
    );
  }
  if (args.published.platform !== args.expectedPlatform) {
    throw new Error(
      `Standalone bundle manifest platform mismatch (expected ${args.expectedPlatform}, got ${args.published.platform})`,
    );
  }
  if (!args.published.fileName || !args.published.url || !args.published.sha256) {
    throw new Error("Standalone bundle manifest is missing required fields");
  }
}

async function runCommand(
  command: string[],
  spawn: SpawnFn = resolveDefaultSpawn(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const proc = spawn({
    cmd: command,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  return proc.exited;
}

function hashFile(path: string) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function fileSize(path: string) {
  return statSync(path).size;
}

async function downloadFile(url: string, destinationPath: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const bytes = await response.arrayBuffer();
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, Buffer.from(bytes));
}

function assertCliDir(cliDir: string) {
  const entrypoint = join(cliDir, "index.js");
  if (!existsSync(entrypoint)) {
    throw new Error(`Standalone CLI layout is invalid: missing ${entrypoint}`);
  }
}

async function extractArchive(args: {
  archivePath: string;
  destDir: string;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}) {
  mkdirSync(args.destDir, { recursive: true });
  const spawn = args.spawn ?? resolveDefaultSpawn();
  const env = args.env ?? process.env;

  if (args.archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const command = [
        "powershell",
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${args.archivePath.replace(/'/g, "''")}' -DestinationPath '${args.destDir.replace(/'/g, "''")}' -Force`,
      ];
      return runCommand(command, spawn, env);
    }
    return runCommand(["unzip", "-qo", args.archivePath, "-d", args.destDir], spawn, env);
  }

  return runCommand(["tar", "--zstd", "-xf", args.archivePath, "-C", args.destDir], spawn, env);
}

function findExtractedBundleRoot(extractDir: string) {
  const matches = readdirSync(extractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nolo-cli-"))
    .map((entry) => join(extractDir, entry.name));
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(
    `Could not locate extracted standalone CLI bundle under ${extractDir}`,
  );
}

function atomicReplaceDirectory(args: { targetDir: string; sourceDir: string }) {
  assertCliDir(args.sourceDir);

  const parent = dirname(args.targetDir);
  mkdirSync(parent, { recursive: true });
  const stagingDir = `${args.targetDir}.staging-${process.pid}`;
  const backupDir = `${args.targetDir}.backup-${process.pid}`;

  rmSync(stagingDir, { recursive: true, force: true });
  cpSync(args.sourceDir, stagingDir, { recursive: true });
  assertCliDir(stagingDir);

  if (existsSync(args.targetDir)) {
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(args.targetDir, backupDir);
  }

  try {
    renameSync(stagingDir, args.targetDir);
  } catch (error) {
    if (existsSync(backupDir) && !existsSync(args.targetDir)) {
      renameSync(backupDir, args.targetDir);
    }
    throw error;
  }

  rmSync(backupDir, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
}

function replaceFileWithFallback(args: {
  sourcePath: string;
  targetPath: string;
  output?: NodeJS.WritableStream;
}) {
  if (!existsSync(args.sourcePath)) {
    return;
  }

  mkdirSync(dirname(args.targetPath), { recursive: true });
  const pendingPath = `${args.targetPath}.pending-${process.pid}`;
  cpSync(args.sourcePath, pendingPath);

  try {
    rmSync(args.targetPath, { force: true });
    renameSync(pendingPath, args.targetPath);
  } catch (error) {
    rmSync(pendingPath, { force: true });
    args.output?.write(
      `[nolo] Warning: could not replace ${args.targetPath} (${error instanceof Error ? error.message : String(error)}). Restart all nolo processes and run nolo update again.\n`,
    );
  }
}

function replaceStandaloneBundleContents(args: {
  currentRoot: string;
  nextRoot: string;
  output?: NodeJS.WritableStream;
}) {
  const nextCliDir = join(args.nextRoot, "lib", "nolo-cli");
  const currentCliDir = join(args.currentRoot, "lib", "nolo-cli");
  if (!existsSync(nextCliDir)) {
    throw new Error(`Downloaded bundle is missing ${nextCliDir}`);
  }

  atomicReplaceDirectory({
    targetDir: currentCliDir,
    sourceDir: nextCliDir,
  });

  for (const relativePath of ["VERSION", "manifest.json"] as const) {
    const source = join(args.nextRoot, relativePath);
    if (existsSync(source)) {
      replaceFileWithFallback({
        sourcePath: source,
        targetPath: join(args.currentRoot, relativePath),
        output: args.output,
      });
    }
  }

  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  replaceFileWithFallback({
    sourcePath: join(args.nextRoot, "bin", bunName),
    targetPath: join(args.currentRoot, "bin", bunName),
    output: args.output,
  });

  const launcherName = process.platform === "win32" ? "nolo.cmd" : "nolo";
  replaceFileWithFallback({
    sourcePath: join(args.nextRoot, "bin", launcherName),
    targetPath: join(args.currentRoot, "bin", launcherName),
    output: args.output,
  });
}

export async function runStandaloneBundleUpdate(args: {
  install: StandaloneBundleInstall;
  serverUrl: string;
  output?: NodeJS.WritableStream;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}) {
  const output = args.output ?? process.stdout;
  const env = args.env ?? process.env;
  const platform =
    resolveCliBundlePlatform() ?? args.install.manifest.platform ?? null;
  if (!platform) {
    throw new Error(
      `Standalone CLI self-update is not supported on ${process.platform}/${process.arch}`,
    );
  }

  const channel = resolveBundleUpdateChannel({
    install: args.install,
    serverUrl: args.serverUrl,
    output,
  });
  const manifestUrl = buildBundleManifestUrl({
    serverUrl: args.serverUrl,
    channel,
    platform,
  });
  output.write(`Checking standalone bundle update: ${manifestUrl}\n`);

  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Standalone bundle manifest not found (${response.status}). Publish the CLI bundle for ${channel}/${platform} first.`,
    );
  }

  const published = (await response.json()) as PublishedStandaloneBundleManifest;
  validatePublishedBundleManifest({
    published,
    expectedChannel: channel,
    expectedPlatform: platform,
  });

  if (!isBundleHostCompatible(published)) {
    const host = published.buildHost;
    throw new Error(
      `Standalone bundle was built for ${host?.platform}/${host?.arch} but the current host is ${process.platform}/${process.arch}. ` +
        `Refusing to install: the native bindings in node_modules/ would be for the wrong platform. ` +
        `Re-run the install script on a ${host?.platform}/${host?.arch} host instead.`
    );
  }

  const currentVersion = args.install.manifest.version;
  if (published.version === currentVersion) {
    output.write(`Already on latest standalone bundle (${currentVersion}).\n`);
    return 0;
  }

  const workDir = join(tmpdir(), `nolo-cli-update-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const archivePath = join(workDir, published.fileName);
    output.write(
      `Updating standalone bundle ${currentVersion} -> ${published.version}\n`,
    );
    output.write(`Downloading ${published.url}\n`);
    await downloadFile(published.url, archivePath);

    const actualSize = fileSize(archivePath);
    if (actualSize !== published.size) {
      throw new Error(
        `Downloaded bundle size mismatch (expected ${published.size} bytes, got ${actualSize} bytes)`,
      );
    }

    const actualSha256 = hashFile(archivePath);
    if (actualSha256 !== published.sha256) {
      throw new Error(
        `Downloaded bundle checksum mismatch (expected ${published.sha256}, got ${actualSha256})`,
      );
    }

    const extractDir = join(workDir, "extracted");
    const exitCode = await extractArchive({
      archivePath,
      destDir: extractDir,
      spawn: args.spawn,
      env,
    });
    if (exitCode !== 0) {
      throw new Error("Failed to extract standalone bundle archive");
    }

    const nextRoot = findExtractedBundleRoot(extractDir);
    replaceStandaloneBundleContents({
      currentRoot: args.install.bundleRoot,
      nextRoot,
      output,
    });

    output.write(`Standalone bundle updated to ${published.version}.\n`);
    output.write("Restart open nolo sessions to use the new version.\n");
    return 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}