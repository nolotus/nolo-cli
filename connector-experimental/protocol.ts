export type MachineHeartbeatInput = {
  machineId?: unknown;
  name?: unknown;
  platform?: unknown;
  arch?: unknown;
  connectorVersion?: unknown;
  capabilities?: unknown;
};

export type MachineHeartbeat = {
  machineId: string;
  name: string;
  platform: string;
  arch: string;
  connectorVersion?: string;
  capabilities: string[];
};

const normalizeRequiredString = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

const normalizeOptionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function normalizeCapabilityList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeMachineHeartbeat(input: MachineHeartbeatInput): MachineHeartbeat {
  const heartbeat: MachineHeartbeat = {
    machineId: normalizeRequiredString(input.machineId, "machineId"),
    name: normalizeRequiredString(input.name, "name"),
    platform: normalizeRequiredString(input.platform, "platform"),
    arch: normalizeRequiredString(input.arch, "arch"),
    capabilities: normalizeCapabilityList(input.capabilities),
  };
  const connectorVersion = normalizeOptionalString(input.connectorVersion);
  if (connectorVersion) heartbeat.connectorVersion = connectorVersion;
  return heartbeat;
}
