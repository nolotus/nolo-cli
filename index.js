#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_PACKAGE_NAMES = [
  "nolo-cli-darwin-arm64",
];

function nativeBinaryName(packageName) {
  return packageName.endsWith("-win32-x64") ? "nolo.exe" : "nolo";
}

function findNativeBinaryInWorkspace(sourceDir) {
  // Monorepo fallback: native packages live as sibling workspace directories.
  // The workspace directory name (e.g. cli-darwin-arm64) may differ from the
  // published package name (e.g. nolo-cli-darwin-arm64).
  const repoPackagesDir = join(sourceDir, "..");
  const workspaceDirNames = ["cli-darwin-arm64"];
  for (const dirName of workspaceDirNames) {
    const binaryPath = join(repoPackagesDir, dirName, nativeBinaryName(dirName));
    if (existsSync(binaryPath)) return binaryPath;
  }
  return null;
}

function findNativeBinary() {
  const sourceDir = dirname(fileURLToPath(import.meta.url));

  // Installed package layout (npm/node_modules).
  const require = createRequire(import.meta.url);
  for (const packageName of NATIVE_PACKAGE_NAMES) {
    try {
      const manifestPath = require.resolve(`${packageName}/package.json`);
      const packageDir = dirname(manifestPath);
      const binaryPath = join(packageDir, nativeBinaryName(packageName));
      if (existsSync(binaryPath)) return binaryPath;
    } catch {
      // Package not installed or unsupported platform.
    }
  }

  // Local workspace layout.
  return findNativeBinaryInWorkspace(sourceDir);
}

function runBinary(binaryPath, args) {
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

function runSourceEntry(args) {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const entryPath = join(sourceDir, "index.ts");
  const bun = process.execPath.endsWith("bun") ? process.execPath : "bun";
  const result = spawnSync(bun, [entryPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

// Force the source entrypoint for development, e.g. when iterating on TS source.
if (process.env.NOLO_CLI_SOURCE === "1") {
  runSourceEntry(process.argv.slice(2));
}

const nativeBinary = findNativeBinary();
if (nativeBinary) {
  runBinary(nativeBinary, process.argv.slice(2));
} else {
  runSourceEntry(process.argv.slice(2));
}
