import fs from "node:fs";
import path from "node:path";

import { toErrorMessage } from "../core/errorMessage";
import {
  createCliAuthorityBrokerClient,
  createCliAuthorityBrokerSocketInvoker,
  isCliAuthorityBrokerUnavailableError,
} from "../database-engine/cliAuthorityBrokerClient";
import type { CliAuthorityBrokerClientOptions } from "../database-engine/cliAuthorityBrokerClient";
import {
  getOrCreateCliAuthorityBrokerServer,
} from "../database-engine/cliAuthorityBrokerServer";
import type { CliAuthorityBrokerServerOptions } from "../database-engine/cliAuthorityBrokerServer";
import {
  resolveCliAuthorityBrokerEndpoint,
  resolveCliAuthorityBrokerHealthPath,
  resolveCliAuthorityBrokerMetadataPath,
} from "../database-engine/cliAuthorityStoreDriver";
import { isLevelLockError } from "../database/levelLockError";
import { resolveNoloHome } from "../database-engine/dbPath";
import type {
  AuthorityBatchOperation,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "../database-engine/authorityStoreTypes";
import { createLevelAuthorityStore } from "../database-engine/levelAuthorityStore";
import { createLegacyServerDb } from "../database-engine/legacyServerDb";

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
  /**
   * PERF: 快速路径开关——先尝试直接 open 连到已有 broker，跳过 startBroker
   * 的 LevelDB open + lock 检测。生产默认 true；测试 mock 的 open 不做真实
   * socket 连接，传 false 跳过快速路径走原有 startBroker 流程。
   */
  useFastPath?: boolean;
};

const defaultCliAuthorityBrokerConnectDeps: CliAuthorityBrokerConnectDeps = {
  createClient: (options) => createCliAuthorityBrokerClient(options),
  startBroker: (options) => getOrCreateCliAuthorityBrokerServer(options),
  sleep,
  useFastPath: true,
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

    // PERF: 快速路径——先尝试直接 open 连到已有 broker。如果 broker 已
    // 存在（TUI/daemon/之前的 agent run 启动的），open 会立即成功，跳过
    // startBroker 的 LevelDB open + lock 检测（实测撞锁路径 ~800ms，
    // 直接 open ~10ms）。如果 broker 不存在，open 会快速失败
    // (ECONNREFUSED)，然后走下面的 startBroker 正常启动路径。
    if (deps.useFastPath) {
      try {
        await client.open();
        return client;
      } catch (error) {
        // H-1: 只在 broker 不可用（ECONNREFUSED / ENOENT 等）时 fallback
        // 到 startBroker。其他 error（如 5s 超时、协议错误）直接 throw，
        // 避免不健康的 broker 导致快速路径等 5s 后再走 fallback 又等 5s。
        if (!isCliAuthorityBrokerUnavailableError(error)) throw error;
      }
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
  // NOLO_HOME says *where this machine keeps its local state*; it is not part
  // of the per-call config a caller curates (auth, model, language). Callers
  // that hand down a partial env — the TUI workspace passes its own env object,
  // and tests routinely pass `{}` — must not silently relocate the database and
  // broker to a different home than the rest of the CLI uses. An explicit
  // NOLO_HOME in the caller's env still wins.
  const ambientNoloHome = process.env.NOLO_HOME?.trim();
  const env = {
    ...(ambientNoloHome ? { NOLO_HOME: ambientNoloHome } : {}),
    ...(options.env ?? process.env),
  };
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
