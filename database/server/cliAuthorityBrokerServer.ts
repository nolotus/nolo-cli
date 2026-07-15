import fs from "node:fs";
import path from "node:path";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { toErrorMessage } from "../../core/errorMessage";

import type { AuthorityStore } from "./authorityStoreTypes";
import type {
  CliAuthorityBrokerIteratorPage,
  CliAuthorityBrokerRequest,
  CliAuthorityBrokerResponse,
} from "./cliAuthorityBrokerTypes";

const brokerRegistry = new Map<string, Promise<CliAuthorityBrokerServerHandle>>();
const DEFAULT_ITERATOR_LIMIT = 200;

export type CliAuthorityBrokerServerOptions = {
  endpoint: string;
  createStore: () => AuthorityStore | Promise<AuthorityStore>;
  metadataPath?: string;
  healthPath?: string;
  now?: () => number;
  transportMode?: "socket" | "inprocess";
};

export type CliAuthorityBrokerServerHandle = {
  endpoint: string;
  listeningEndpoint: string;
  authorityStore: AuthorityStore;
  request(request: CliAuthorityBrokerRequest): Promise<CliAuthorityBrokerResponse>;
  close(): Promise<void>;
};

type BrokerListenTarget =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

function resolveBrokerListenTarget(endpoint: string): BrokerListenTarget {
  if (endpoint.startsWith("unix://")) {
    return { kind: "unix", path: endpoint.slice("unix://".length) };
  }
  if (endpoint.startsWith("tcp://")) {
    const url = new URL(endpoint);
    return {
      kind: "tcp",
      host: url.hostname,
      port: Number(url.port),
    };
  }
  throw new Error(`Unsupported CLI authority broker endpoint: ${endpoint}`);
}

function buildListeningEndpoint(server: Server, target: BrokerListenTarget) {
  if (target.kind === "unix") {
    return `unix://${target.path}`;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    return `tcp://${target.host}:${target.port}`;
  }
  const info = address as AddressInfo;
  return `tcp://${target.host}:${info.port}`;
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath: string | undefined, data: Record<string, unknown>) {
  if (!filePath) return;
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function removeFileIfPresent(filePath: string | undefined) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

async function buildIteratorPage(
  store: AuthorityStore,
  request: Extract<CliAuthorityBrokerRequest, { type: "iterator" }>
): Promise<CliAuthorityBrokerIteratorPage> {
  const rows: Array<[string, unknown]> = [];
  for await (const entry of store.iterator(request.options ?? {})) {
    rows.push(entry as [string, unknown]);
  }

  const startIndex = request.cursor
    ? rows.findIndex(([key]) => key === request.cursor) + 1
    : 0;
  const limit = request.limit ?? DEFAULT_ITERATOR_LIMIT;
  const entries = rows.slice(startIndex, startIndex + limit);
  const lastEntry = entries.at(-1) ?? null;

  return {
    entries,
    nextCursor: lastEntry ? lastEntry[0] : null,
    done: startIndex + entries.length >= rows.length,
  };
}

function createErrorResponse(error: unknown): CliAuthorityBrokerResponse {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as any).code === "string" &&
    typeof (error as any).message === "string"
  ) {
    return {
      ok: false,
      error: {
        code: (error as any).code,
        message: (error as any).message,
        retryable: (error as any).retryable === true,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "BROKER_INTERNAL_ERROR",
      message: toErrorMessage(error),
    },
  };
}

export async function dispatchCliAuthorityBrokerRequest(
  store: AuthorityStore,
  request: CliAuthorityBrokerRequest
): Promise<CliAuthorityBrokerResponse> {
  try {
    switch (request.type) {
      case "status":
        return { ok: true, result: { type: "status" } };
      case "open":
        await store.open();
        return { ok: true, result: { type: "open" } };
      case "close":
        await store.close();
        return { ok: true, result: { type: "close" } };
      case "get":
        return { ok: true, result: { type: "get", value: await store.get(request.key) } };
      case "put":
        await store.put(request.key, request.value);
        return { ok: true, result: { type: "put" } };
      case "del":
        await store.del(request.key);
        return { ok: true, result: { type: "del" } };
      case "batchWrite":
        await store.batchWrite(request.ops);
        return { ok: true, result: { type: "batchWrite" } };
      case "iterator":
        return {
          ok: true,
          result: {
            type: "iterator",
            page: await buildIteratorPage(store, request),
          },
        };
    }
  } catch (error) {
    return createErrorResponse(error);
  }
}

async function createBrokerHandle(
  options: CliAuthorityBrokerServerOptions
): Promise<CliAuthorityBrokerServerHandle> {
  const target = resolveBrokerListenTarget(options.endpoint);
  if (target.kind === "unix") {
    ensureParentDir(target.path);
    removeFileIfPresent(target.path);
  }

  const store = await options.createStore();
  await store.open();

  const server = createServer((socket) => {
    bindSocketRequestHandler({ socket, store });
  });

  if ((options.transportMode ?? "socket") === "socket") {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (target.kind === "unix") {
          server.listen(target.path, () => {
            server.off("error", reject);
            resolve();
          });
          return;
        }
        server.listen(target.port, target.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.unref();
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }

  const now = options.now ?? Date.now;
  const listeningEndpoint = (options.transportMode ?? "socket") === "socket"
    ? buildListeningEndpoint(server, target)
    : options.endpoint;
  writeJsonFile(options.metadataPath, {
    pid: process.pid,
    endpoint: listeningEndpoint,
    location: store.location ?? listeningEndpoint,
    startedAt: new Date(now()).toISOString(),
  });
  writeJsonFile(options.healthPath, {
    ok: true,
    pid: process.pid,
    endpoint: listeningEndpoint,
    checkedAt: new Date(now()).toISOString(),
  });

  let closed = false;
  return {
    endpoint: options.endpoint,
    listeningEndpoint,
    authorityStore: store,
    request(request: CliAuthorityBrokerRequest) {
      return dispatchCliAuthorityBrokerRequest(store, request);
    },
    async close() {
      if (closed) return;
      closed = true;
      brokerRegistry.delete(options.endpoint);
      if ((options.transportMode ?? "socket") === "socket") {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      await store.close();
      if (target.kind === "unix") {
        removeFileIfPresent(target.path);
      }
      removeFileIfPresent(options.metadataPath);
      removeFileIfPresent(options.healthPath);
    },
  };
}

function bindSocketRequestHandler(args: { socket: Socket; store: AuthorityStore }) {
  let buffer = "";
  args.socket.setEncoding("utf8");
  args.socket.on("data", async (chunk) => {
    buffer += chunk;
    if (!buffer.includes("\n")) return;
    const [rawRequest] = buffer.split("\n");
    buffer = "";
    let response: CliAuthorityBrokerResponse;
    try {
      response = await dispatchCliAuthorityBrokerRequest(
        args.store,
        JSON.parse(rawRequest) as CliAuthorityBrokerRequest
      );
    } catch (error) {
      response = createErrorResponse(error);
    }
    args.socket.end(`${JSON.stringify(response)}\n`);
  });
}

export function getOrCreateCliAuthorityBrokerServer(
  options: CliAuthorityBrokerServerOptions
): Promise<CliAuthorityBrokerServerHandle> {
  const existing = brokerRegistry.get(options.endpoint);
  if (existing) return existing;

  const pending = createBrokerHandle(options).catch((error) => {
    brokerRegistry.delete(options.endpoint);
    throw error;
  });
  brokerRegistry.set(options.endpoint, pending);
  return pending;
}
