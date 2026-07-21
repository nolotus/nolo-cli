import fs from "node:fs/promises";

import { toErrorMessage } from "../core/errorMessage";
import {
  createCliAuthorityBrokerClient,
  createCliAuthorityBrokerSocketInvoker,
} from "../database-engine/cliAuthorityBrokerClient";

type BrokerHealthRecord = {
  ok?: unknown;
  pid?: unknown;
  endpoint?: unknown;
};

type CliAuthorityBrokerHealthDeps = {
  readJson: (filePath: string) => Promise<unknown>;
  isPidAlive: (pid: number) => boolean;
  openEndpoint: (endpoint: string) => Promise<void>;
};

const defaultCliAuthorityBrokerHealthDeps: CliAuthorityBrokerHealthDeps = {
  async readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  },
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: unknown }).code === "EPERM";
    }
  },
  async openEndpoint(endpoint) {
    const client = createCliAuthorityBrokerClient({
      endpoint,
      invoke: createCliAuthorityBrokerSocketInvoker({ endpoint }),
    });
    await client.open();
  },
};

function asBrokerHealthRecord(value: unknown): BrokerHealthRecord {
  return typeof value === "object" && value !== null
    ? value as BrokerHealthRecord
    : {};
}

export async function probeCliAuthorityBrokerHealth(args: {
  endpoint: string;
  metadataPath: string;
  healthPath: string;
  deps?: Partial<CliAuthorityBrokerHealthDeps>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const deps = {
    ...defaultCliAuthorityBrokerHealthDeps,
    ...args.deps,
  };

  let metadata: BrokerHealthRecord;
  let health: BrokerHealthRecord;
  try {
    [metadata, health] = await Promise.all([
      deps.readJson(args.metadataPath).then(asBrokerHealthRecord),
      deps.readJson(args.healthPath).then(asBrokerHealthRecord),
    ]);
  } catch (error) {
    return {
      ok: false,
      error: `authority broker health artifacts are unavailable: ${toErrorMessage(error)}`,
    };
  }

  if (health.ok !== true) {
    return { ok: false, error: "authority broker health artifact is not ok" };
  }
  if (
    typeof metadata.endpoint !== "string" ||
    metadata.endpoint !== args.endpoint ||
    health.endpoint !== args.endpoint
  ) {
    return { ok: false, error: "authority broker endpoint metadata does not match" };
  }
  if (
    typeof metadata.pid !== "number" ||
    !Number.isInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    health.pid !== metadata.pid
  ) {
    return { ok: false, error: "authority broker pid metadata is invalid" };
  }
  if (!deps.isPidAlive(metadata.pid)) {
    return {
      ok: false,
      error: `authority broker metadata pid ${metadata.pid} is not alive`,
    };
  }

  try {
    await deps.openEndpoint(args.endpoint);
  } catch (error) {
    return {
      ok: false,
      error: `authority broker endpoint is unreachable: ${toErrorMessage(error)}`,
    };
  }

  return { ok: true };
}
