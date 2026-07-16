import fs from "node:fs";
import path from "node:path";

import { toErrorMessage } from "../core/errorMessage";
import {
  createCliAuthorityBrokerClient,
  createCliAuthorityBrokerSocketInvoker,
  isCliAuthorityBrokerUnavailableError,
} from "../database/server/cliAuthorityBrokerClient";
import type { CliAuthorityBrokerClientOptions } from "../database/server/cliAuthorityBrokerClient";
import {
  getOrCreateCliAuthorityBrokerServer,
} from "../database/server/cliAuthorityBrokerServer";
import type { CliAuthorityBrokerServerOptions } from "../database/server/cliAuthorityBrokerServer";
import {
  resolveCliAuthorityBrokerEndpoint,
  resolveCliAuthorityBrokerHealthPath,
  resolveCliAuthorityBrokerMetadataPath,
} from "../database/server/cliAuthorityStoreDriver";
import { isLevelLockError } from "../database/levelLockError";
import { resolveNoloHome } from "../database/server/dbPath";
import type {
  AuthorityBatchOperation,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "../database/server/authorityStoreTypes";
import { createLevelAuthorityStore } from "../database/server/levelAuthorityStore";
import { createLegacyServerDb } from "../database/server/legacyServerDb";

type EnvLike = Record<string, string | undefined>;

type ResolveCliLocalRuntimeAuthorityOptions = {
  env?: EnvLike;
  homeDir?: string;
};

function ensureDbParentDir(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

/** Level lock (shared pure seam) plus CLI broker bind/start contention shapes. */
function isCliAuthorityLockError(error: unknown) {
  if (isLevelLockError(error)) return true;
  const message = toErrorMessage(error);
  return /Database failed to open|EADDRINUSE|Failed to listen/i.test(message);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCliLocalRuntimeDbPath(options: ResolveCliLocalRuntimeAuthorityOptions = {}) {
  return path.join(
    resolveNoloHome({
      env: options.env,
      homeDir: options.homeDir,
    }),
    "data",
    "leveldb"
  );
}

type CliAuthorityBrokerConnectDeps = {
  createClient: (options: CliAuthorityBrokerClientOptions) => AuthorityStore;
  startBroker: (options: CliAuthorityBrokerServerOptions) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
};

const defaultCliAuthorityBrokerConnectDeps: CliAuthorityBrokerConnectDeps = {
  createClient: (options) => createCliAuthorityBrokerClient(options),
  startBroker: (options) => getOrCreateCliAuthorityBrokerServer(options),
  sleep,
};

export async function connectCliAuthorityBroker(args: {
  endpoint: string;
  metadataPath: string;
  healthPath: string;
  dbPath: string;
  deps?: Partial<CliAuthorityBrokerConnectDeps>;
}) {
  const deps: CliAuthorityBrokerConnectDeps = {
    ...defaultCliAuthorityBrokerConnectDeps,
    ...args.deps,
  };

  async function connectClient() {
    const client = deps.createClient({
      endpoint: args.endpoint,
      invoke: createCliAuthorityBrokerSocketInvoker({ endpoint: args.endpoint }),
    });

    async function attachToExistingBroker(attempts: number) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await deps.sleep(100);
        try {
          await client.open();
          return true;
        } catch (error) {
          if (!isCliAuthorityBrokerUnavailableError(error)) throw error;
        }
      }
      return false;
    }

    try {
      await deps.startBroker({
        endpoint: args.endpoint,
        metadataPath: args.metadataPath,
        healthPath: args.healthPath,
        createStore: () => createLevelAuthorityStore(args.dbPath),
      });
      await client.open();
      return client;
    } catch (error) {
      if (!isCliAuthorityLockError(error)) throw error;

      if (await attachToExistingBroker(5)) {
        return client;
      }

      let lastError: unknown = error;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await deps.sleep(100);
        try {
          await deps.startBroker({
            endpoint: args.endpoint,
            metadataPath: args.metadataPath,
            healthPath: args.healthPath,
            createStore: () => createLevelAuthorityStore(args.dbPath),
          });
          await client.open();
          return client;
        } catch (retryError) {
          lastError = retryError;
          if (isCliAuthorityLockError(retryError)) {
            if (await attachToExistingBroker(2)) {
              return client;
            }
            continue;
          }
          if (isCliAuthorityBrokerUnavailableError(retryError)) {
            continue;
          }
          throw retryError;
        }
      }
      throw new Error(`CLI authority broker could not attach or take ownership for ${args.endpoint}`, {
        cause: lastError,
      });
    }
  }

  let client = await connectClient();
  let reconnecting: Promise<AuthorityStore> | null = null;

  async function reconnect() {
    reconnecting ??= connectClient();
    try {
      client = await reconnecting;
      return client;
    } finally {
      reconnecting = null;
    }
  }

  async function runWithSelfHealing<T>(
    operation: (activeClient: AuthorityStore) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(client);
    } catch (error) {
      if (!isCliAuthorityBrokerUnavailableError(error)) throw error;
      const recoveredClient = await reconnect();
      return operation(recoveredClient);
    }
  }

  return {
    get location() {
      return client.location;
    },
    get status() {
      return client.status;
    },
    open: () => runWithSelfHealing((activeClient) => activeClient.open()),
    close: () => runWithSelfHealing((activeClient) => activeClient.close()),
    get: (key: string) =>
      runWithSelfHealing((activeClient) => activeClient.get(key)),
    put: (key: string, value: unknown) =>
      runWithSelfHealing((activeClient) => activeClient.put(key, value)),
    del: (key: string) =>
      runWithSelfHealing((activeClient) => activeClient.del(key)),
    batchWrite: (ops: AuthorityBatchOperation[]) =>
      runWithSelfHealing((activeClient) => activeClient.batchWrite(ops)),
    createBatch() {
      const ops: AuthorityBatchOperation[] = [];
      return {
        put(key: string, value: unknown) {
          ops.push({ type: "put", key, value });
        },
        del(key: string) {
          ops.push({ type: "del", key });
        },
        write: () =>
          runWithSelfHealing((activeClient) => activeClient.batchWrite(ops)),
      };
    },
    iterator(options: AuthorityIteratorOptions = {}) {
      return (async function* iterate() {
        let activeOptions = options;
        let lastYieldedKey: string | undefined;
        let skipResumeKey = false;
        let recovered = false;

        while (true) {
          try {
            for await (const entry of client.iterator(activeOptions)) {
              if (skipResumeKey && entry[0] === lastYieldedKey) {
                skipResumeKey = false;
                continue;
              }
              skipResumeKey = false;
              lastYieldedKey = entry[0];
              yield entry;
            }
            return;
          } catch (error) {
            if (
              recovered ||
              !isCliAuthorityBrokerUnavailableError(error)
            ) {
              throw error;
            }
            recovered = true;
            await reconnect();
            if (lastYieldedKey === undefined) {
              activeOptions = options;
              continue;
            }
            if (options.reverse) {
              activeOptions = {
                ...options,
                lt: lastYieldedKey,
              };
              continue;
            }
            activeOptions = {
              ...options,
              gte: lastYieldedKey,
            };
            skipResumeKey = true;
          }
        }
      })();
    },
  } satisfies AuthorityStore;
}

export async function getDefaultCliLocalRuntimeAuthority(
  options: ResolveCliLocalRuntimeAuthorityOptions = {}
) {
  const env = options.env ?? process.env;
  const dbPath = resolveCliLocalRuntimeDbPath({
    env,
    homeDir: options.homeDir,
  });
  ensureDbParentDir(dbPath);
  const endpoint = resolveCliAuthorityBrokerEndpoint({
    transport: "tcp",
    env,
    homeDir: options.homeDir,
  });
  const metadataPath = resolveCliAuthorityBrokerMetadataPath({
    transport: "tcp",
    env,
    homeDir: options.homeDir,
  });
  const healthPath = resolveCliAuthorityBrokerHealthPath({
    transport: "tcp",
    env,
    homeDir: options.homeDir,
  });
  return connectCliAuthorityBroker({
    endpoint,
    metadataPath,
    healthPath,
    dbPath,
  });
}

export async function getDefaultCliLocalRuntimeDb(
  options: ResolveCliLocalRuntimeAuthorityOptions = {}
) {
  const authorityStore = await getDefaultCliLocalRuntimeAuthority(options);
  return createLegacyServerDb(authorityStore);
}
