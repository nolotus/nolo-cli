import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, hostname, homedir, platform } from "node:os";
import { randomUUID } from "node:crypto";

import { detectRuntimeCapabilities } from "./capabilities";
import type { MachineHeartbeat } from "./protocol";

const CONNECTOR_VERSION = "0.1.0-experimental";

function defaultMachineIdPath() {
  // NOLO_HOME-aware like every other nolo path, so a test process cannot mint
  // (or inherit) the developer's real machine identity.
  const noloHome = process.env.NOLO_HOME?.trim();
  return noloHome
    ? join(noloHome, "machine-id")
    : join(homedir(), ".nolo", "machine-id");
}

export function resolveMachineId(path = defaultMachineIdPath()) {
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing) return existing;
    }
    const next = `machine-${randomUUID()}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${next}\n`, "utf8");
    return next;
  } catch {
    return `machine-${hostname().toLowerCase()}`;
  }
}

export function detectMachineInfo(overrides?: {
  machineId?: string;
  name?: string;
  capabilities?: string[];
  probeLaunchable?: boolean;
}): MachineHeartbeat {
  return {
    machineId: overrides?.machineId ?? resolveMachineId(),
    name: overrides?.name ?? hostname(),
    platform: platform(),
    arch: arch(),
    connectorVersion: CONNECTOR_VERSION,
    capabilities: overrides?.capabilities ?? detectRuntimeCapabilities({
      probeLaunchable: overrides?.probeLaunchable,
    }),
  };
}
