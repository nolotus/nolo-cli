import {
  NOLO_CLUSTER_SERVERS,
  normalizeKnownServerOrigin,
} from "../config";
import { BUILTIN_PLATFORM_AGENT_KEYS as CORE_BUILTIN_PLATFORM_AGENT_KEYS } from "../../core/builtinAgents";

export const BUILTIN_PLATFORM_AGENT_KEYS = [
  ...CORE_BUILTIN_PLATFORM_AGENT_KEYS,
] as const;

const BUILTIN_PLATFORM_AGENT_KEY_SET = new Set<string>(
  BUILTIN_PLATFORM_AGENT_KEYS
);

const normalizeServer = (server: string): string =>
  normalizeKnownServerOrigin(server) ?? server.trim().replace(/\/+$/, "");

export const isBuiltinPlatformAgentKey = (dbKey: string): boolean =>
  typeof dbKey === "string" && BUILTIN_PLATFORM_AGENT_KEY_SET.has(dbKey);

export const resolveAgentReadServers = ({
  dbKey,
  configuredServers,
}: {
  dbKey: string;
  configuredServers: string[];
}): string[] => {
  const normalized = configuredServers.map(normalizeServer);
  if (!isBuiltinPlatformAgentKey(dbKey)) {
    return Array.from(new Set(normalized));
  }
  return Array.from(new Set([...normalized, ...NOLO_CLUSTER_SERVERS]));
};
