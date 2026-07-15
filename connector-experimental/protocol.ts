import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../core/stringArray";

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

export function normalizeCapabilityList(value: unknown): string[] {
  return [...new Set(asTrimmedNonEmptyStringArray(value))];
}

export function normalizeMachineHeartbeat(input: MachineHeartbeatInput): MachineHeartbeat {
  const heartbeat: MachineHeartbeat = {
    machineId: normalizeRequiredString(input.machineId, "machineId"),
    name: normalizeRequiredString(input.name, "name"),
    platform: normalizeRequiredString(input.platform, "platform"),
    arch: normalizeRequiredString(input.arch, "arch"),
    capabilities: normalizeCapabilityList(input.capabilities),
  };
  const connectorVersion = asOptionalTrimmedString(input.connectorVersion);
  if (connectorVersion) heartbeat.connectorVersion = connectorVersion;
  return heartbeat;
}
