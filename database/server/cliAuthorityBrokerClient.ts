import type {
  AuthorityBatchOperation,
  AuthorityBatchWriter,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "./authorityStoreTypes";
import type {
  CliAuthorityBrokerRequest,
  CliAuthorityBrokerResponse,
} from "./cliAuthorityBrokerTypes";
import { createConnection } from "node:net";

const DEFAULT_ITERATOR_PAGE_SIZE = 200;

export class CliAuthorityBrokerUnavailableError extends Error {
  readonly reason = "cli_authority_broker_unavailable";
  readonly status = 503;
  readonly endpoint: string;

  constructor(endpoint: string, cause?: unknown) {
    super(`CLI authority broker unavailable at ${endpoint}. Start the local authority broker and retry.`);
    this.name = "CliAuthorityBrokerUnavailableError";
    this.endpoint = endpoint;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class CliAuthorityBrokerProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: { code: string; message: string; retryable?: boolean }) {
    super(error.message);
    this.name = "CliAuthorityBrokerProtocolError";
    this.code = error.code;
    this.retryable = error.retryable === true;
  }
}

export function isCliAuthorityBrokerUnavailableError(
  error: unknown
): error is CliAuthorityBrokerUnavailableError {
  return (
    error instanceof CliAuthorityBrokerUnavailableError ||
    (
      typeof error === "object" &&
      error !== null &&
      (error as any).reason === "cli_authority_broker_unavailable" &&
      (error as any).status === 503
    )
  );
}

function isCliAuthorityBrokerProtocolError(
  error: unknown
): error is CliAuthorityBrokerProtocolError {
  return error instanceof CliAuthorityBrokerProtocolError;
}

export type CliAuthorityBrokerRequestInvoker = (
  request: CliAuthorityBrokerRequest
) => Promise<CliAuthorityBrokerResponse>;

export type CliAuthorityBrokerClientOptions = {
  endpoint: string;
  location?: string;
  status?: string;
  invoke: CliAuthorityBrokerRequestInvoker;
  iteratorPageSize?: number;
};

type BrokerSocketTarget =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

function resolveBrokerSocketTarget(endpoint: string): BrokerSocketTarget {
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

export function createCliAuthorityBrokerSocketInvoker(options: {
  endpoint: string;
}): CliAuthorityBrokerRequestInvoker {
  const target = resolveBrokerSocketTarget(options.endpoint);
  return async (request: CliAuthorityBrokerRequest) => {
    return await new Promise<CliAuthorityBrokerResponse>((resolve, reject) => {
      const socket = target.kind === "unix"
        ? createConnection(target.path)
        : createConnection({ host: target.host, port: target.port });
      let responseBuffer = "";
      let settled = false;

      const timeout = setTimeout(() => {
        finish(() => {
          socket.destroy();
          reject(new Error(`CLI authority broker request at ${options.endpoint} timed out after 5000ms`));
        });
      }, 5000);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk) => {
        responseBuffer += chunk;
      });
      socket.on("end", () => {
        finish(() => {
          const payload = responseBuffer.trim();
          if (!payload) {
            reject(new Error(`CLI authority broker at ${options.endpoint} returned no response`));
            return;
          }
          try {
            resolve(JSON.parse(payload) as CliAuthorityBrokerResponse);
          } catch (error) {
            reject(error);
          }
        });
      });
      socket.on("error", (error) => {
        finish(() => reject(error));
      });
    });
  };
}

async function invokeBrokerRequest(
  options: CliAuthorityBrokerClientOptions,
  request: CliAuthorityBrokerRequest
) {
  try {
    const response = await options.invoke(request);
    if (response.ok) return response.result;
    if (response.error.code === "BROKER_UNAVAILABLE") {
      throw new CliAuthorityBrokerUnavailableError(options.endpoint, response.error);
    }
    throw new CliAuthorityBrokerProtocolError(response.error);
  } catch (error) {
    if (isCliAuthorityBrokerUnavailableError(error)) throw error;
    if (isCliAuthorityBrokerProtocolError(error)) throw error;
    throw new CliAuthorityBrokerUnavailableError(options.endpoint, error);
  }
}

export function createCliAuthorityBrokerClient(
  options: CliAuthorityBrokerClientOptions
): AuthorityStore {
  const pageSize = options.iteratorPageSize ?? DEFAULT_ITERATOR_PAGE_SIZE;

  return {
    get location() {
      return options.location ?? options.endpoint;
    },
    get status() {
      return options.status ?? "broker";
    },
    async open() {
      await invokeBrokerRequest(options, { type: "status" });
    },
    async close() {},
    async get<T = any>(key: string) {
      const result = await invokeBrokerRequest(options, { type: "get", key });
      if (result.type !== "get") {
        throw new Error(`CLI authority broker protocol mismatch for get at ${options.endpoint}`);
      }
      return result.value as T;
    },
    async put(key: string, value: unknown) {
      await invokeBrokerRequest(options, { type: "put", key, value });
    },
    async del(key: string) {
      await invokeBrokerRequest(options, { type: "del", key });
    },
    async batchWrite(ops: AuthorityBatchOperation[]) {
      await invokeBrokerRequest(options, { type: "batchWrite", ops });
    },
    createBatch(): AuthorityBatchWriter {
      const ops: AuthorityBatchOperation[] = [];
      return {
        put(key: string, value: unknown) {
          ops.push({ type: "put", key, value });
        },
        del(key: string) {
          ops.push({ type: "del", key });
        },
        async write() {
          await invokeBrokerRequest(options, { type: "batchWrite", ops });
        },
      };
    },
    iterator(iteratorOptions: AuthorityIteratorOptions = {}) {
      return (async function* iterate() {
        let cursor: string | null | undefined = undefined;
        while (true) {
          const result = await invokeBrokerRequest(options, {
            type: "iterator",
            options: iteratorOptions,
            cursor,
            limit: pageSize,
          });
          if (result.type !== "iterator") {
            throw new Error(
              `CLI authority broker protocol mismatch for iterator at ${options.endpoint}`
            );
          }
          for (const entry of result.page.entries) {
            yield entry;
          }
          if (result.page.done || !result.page.nextCursor) return;
          cursor = result.page.nextCursor;
        }
      })();
    },
  };
}
