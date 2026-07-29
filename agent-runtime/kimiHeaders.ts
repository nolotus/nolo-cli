/**
 * Kimi Code compatible request headers.
 *
 * Kimi Code's API validates client identity via User-Agent and X-Msh-* headers.
 * This module mirrors the official kimi-cli's header construction so that
 * nolo requests pass the client identity check.
 *
 * Source of truth: opencode-kimi-full src/headers.ts + src/constants.ts,
 * which mirror kimi-cli v1.41.0 (research/kimi-cli/src/kimi_cli/auth/oauth.py).
 */

import {
  arch,
  hostname,
  homedir,
  type as osType,
  release,
  machine,
  version,
} from "node:os";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export const KIMI_UPSTREAM_VERSION = "1.41.0";
const KIMI_CODE_USER_AGENT = `KimiCLI/${KIMI_UPSTREAM_VERSION}`;
const KIMI_PLATFORM = "kimi_cli";

function asciiSanitize(value: string, fallback = "unknown"): string {
  const cleaned = value.replace(/[^\x20-\x7E]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Check if a request URL targets the Kimi Code API.
 */
export function isKimiCodeEndpoint(url: string): boolean {
  return url.includes("api.kimi.com");
}

/**
 * Build Kimi Code-compatible request headers.
 *
 * Reads the real device_id from ~/.kimi/device_id (persisted by the
 * official kimi-cli). Falls back to generating a UUIDv4 (no dashes) and
 * persisting it when the file is missing, so every nolo install has a
 * stable fingerprint (mirrors opencode-kimi-full src/headers.ts getDeviceId).
 */
export function buildKimiCodeHeaders(): Record<string, string> {
  const deviceId = readOrCreateKimiDeviceId();
  const deviceModel = resolveDeviceModel();
  const osVersion = resolveOsVersion();

  return {
    "User-Agent": KIMI_CODE_USER_AGENT,
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": KIMI_UPSTREAM_VERSION,
    "X-Msh-Device-Name": asciiSanitize(hostname(), "nolo-agent"),
    "X-Msh-Device-Model": asciiSanitize(deviceModel),
    "X-Msh-Os-Version": asciiSanitize(osVersion),
    "X-Msh-Device-Id": asciiSanitize(deviceId, "nolo-agent"),
  };
}

/**
 * kimi-cli persists its device id at `~/.kimi/device_id` as a plain UUIDv4
 * hex string (no dashes). We intentionally share the same path so users who
 * also run the real kimi CLI keep a single stable fingerprint.
 *
 * If the file doesn't exist, generate one (mode 0600, dir mode 0700).
 */
function readOrCreateKimiDeviceId(): string {
  const dir = join(homedir(), ".kimi");
  const path = join(dir, "device_id");

  try {
    if (existsSync(path)) {
      const id = readFileSync(path, "utf8").trim();
      if (id.length > 0) return id;
    }
    // Generate and persist a new device_id
    const id = randomUUID().replace(/-/g, "");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, id, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(dir, 0o700);
      chmodSync(path, 0o600);
    } catch {
      // Best-effort on platforms that ignore chmod.
    }
    return id;
  } catch {
    // Last-resort: deterministic fallback (not persisted)
    return "nolo-agent";
  }
}

function resolveDeviceModel(): string {
  // os.arch() returns "x64" but Kimi's backend expects "x86_64".
  // os.machine() returns the full arch string. Prefer it when available.
  const sysArch = typeof machine === "function" ? machine() || arch() : arch();
  const sysType = osType();
  const sysRelease = release();

  if (sysType === "Darwin") {
    let macVersion = sysRelease;
    try {
      const v = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
      if (v) macVersion = v;
    } catch {
      // use os.release() fallback
    }
    return `macOS ${macVersion} ${sysArch}`;
  }
  if (sysType === "Windows_NT") {
    return `Windows ${sysRelease} ${sysArch}`;
  }
  return `${sysType} ${sysRelease} ${sysArch}`;
}

function resolveOsVersion(): string {
  // os.version() is available on Node 18+ and returns a detailed OS version
  // string (e.g. "Darwin Kernel Version 24.0.0 ..."). Fall back to type+release
  // for older runtimes.
  if (typeof version === "function") {
    const v = version();
    if (v && v !== "unknown") return v;
  }
  return `${osType()} ${release()}`;
}
