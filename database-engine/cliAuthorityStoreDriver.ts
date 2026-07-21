import path from "node:path";

import { resolveNoloHome, type ResolveServerDbPathOptions } from "./dbPath";

export type CliAuthorityStoreDriver = "broker";
export type CliAuthorityBrokerTransport = "tcp" | "unix";

type EnvLike = Record<string, string | undefined>;

type CliAuthorityStoreDriverOptions = ResolveServerDbPathOptions & {
  env?: EnvLike;
};

type CliAuthorityBrokerOptions = CliAuthorityStoreDriverOptions & {
  transport: CliAuthorityBrokerTransport;
};

function readCliAuthorityDriver(
  env: EnvLike
): { driver: CliAuthorityStoreDriver; invalidDriver: string | null } {
  const value = env.NOLO_CLI_AUTHORITY_DRIVER?.trim();
  if (value === "broker") {
    return { driver: "broker", invalidDriver: null };
  }
  return {
    driver: "broker",
    invalidDriver: value ? value : null,
  };
}

function resolveCliAuthorityRunDir(options: CliAuthorityStoreDriverOptions = {}) {
  return path.join(resolveNoloHome({
    ...options,
    env: options.env ?? {},
  }), "run");
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function resolveCliAuthorityBrokerPort(
  options: CliAuthorityStoreDriverOptions = {}
) {
  const envPort = options.env?.NOLO_CLI_AUTHORITY_BROKER_PORT?.trim();
  if (envPort) {
    const port = Number(envPort);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  const noloHome = resolveNoloHome({
    ...options,
    env: options.env ?? {},
  });
  return 47000 + (hashString(noloHome) % 2000);
}

export function resolveCliAuthorityStoreDriver(
  options: CliAuthorityStoreDriverOptions = {}
): CliAuthorityStoreDriver {
  return readCliAuthorityDriver(options.env ?? {}).driver;
}

export function resolveCliAuthorityStoreDriverConfig(
  options: CliAuthorityStoreDriverOptions = {}
) {
  return readCliAuthorityDriver(options.env ?? {});
}

export function resolveCliAuthorityBrokerSocketPath(
  options: CliAuthorityBrokerOptions
) {
  return path.join(resolveCliAuthorityRunDir(options), "authority-store-broker.sock");
}

export function resolveCliAuthorityBrokerEndpoint(
  options: CliAuthorityBrokerOptions
) {
  if (options.transport === "tcp") {
    return `tcp://127.0.0.1:${resolveCliAuthorityBrokerPort(options)}`;
  }
  return `unix://${resolveCliAuthorityBrokerSocketPath(options)}`;
}

export function resolveCliAuthorityBrokerMetadataPath(
  options: CliAuthorityBrokerOptions
) {
  return path.join(resolveCliAuthorityRunDir(options), "authority-store-broker.json");
}

export function resolveCliAuthorityBrokerHealthPath(
  options: CliAuthorityBrokerOptions
) {
  return path.join(resolveCliAuthorityRunDir(options), "authority-store-broker.health.json");
}
