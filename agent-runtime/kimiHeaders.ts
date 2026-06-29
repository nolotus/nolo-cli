/**
 * Kimi Code compatible request headers.
 *
 * Kimi Code's API validates client identity via User-Agent and X-Msh-* headers.
 * This module mirrors the official kimi-code CLI's header construction so that
 * nolo requests pass the client identity check.
 *
 * Source of truth: MoonshotAI/kimi-code packages/oauth/src/identity.ts
 * and pi-provider-kimi-code src/device.ts
 */

import { arch, hostname, homedir, type as osType, release } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const KIMI_UPSTREAM_VERSION = "0.18.0";
const KIMI_CODE_USER_AGENT = `kimi-code-cli/${KIMI_UPSTREAM_VERSION}`;
const KIMI_PLATFORM = "kimi_code_cli";

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
 * Reads the real device_id from ~/.kimi-code/device_id (persisted by the
 * official kimi-code CLI). Falls back to a static identifier when the file
 * is missing (e.g. on a server that never ran the CLI).
 */
export function buildKimiCodeHeaders(): Record<string, string> {
  const deviceId = readKimiDeviceId();
  const deviceModel = resolveDeviceModel();
  const osVersion = release();

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

function readKimiDeviceId(): string {
  try {
    const path = join(homedir(), ".kimi-code", "device_id");
    if (existsSync(path)) {
      const id = readFileSync(path, "utf8").trim();
      if (id.length > 0) return id;
    }
  } catch {
    // ignore — fall through to default
  }
  return "nolo-agent";
}

function resolveDeviceModel(): string {
  const sysType = osType();
  const sysRelease = release();
  const sysArch = arch();

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

