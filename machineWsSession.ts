import { toErrorMessage } from "./core/errorMessage";
import { parsePositiveFiniteNumberOrFallback } from "./core/positiveFiniteNumberOrFallback";
import type { HeartbeatLoopOptions } from "./connector-experimental/heartbeatLoop";
import type { MachineHeartbeat } from "./connector-experimental/protocol";
import {
  isConnectorWebSocketAuthError,
  isConnectorWebSocketRetryableError,
} from "./connectorWebSocketTarget";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

export type ConnectorWebSocketOptions = {
  headers: Record<string, string>;
  onMessage: (message: string) => void | Promise<void>;
  sentMessages: string[];
  signal?: AbortSignal;
};

export type RunMachineWsSessionResult = {
  exitCode: number;
  retryAfterMs?: number;
  reconnectReason?: string;
};

const CONNECTOR_WS_KEEPALIVE_MS = 25_000;

function buildConnectorKeepaliveMessage() {
  return JSON.stringify({ type: "connector.keepalive", sentAt: Date.now() });
}

function resolveHeartbeatIntervalMs(env: EnvLike) {
  return parsePositiveFiniteNumberOrFallback(
    env.NOLO_CONNECT_HEARTBEAT_MS,
    30_000,
  );
}

export async function defaultConnectWebSocket(
  url: string,
  options: ConnectorWebSocketOptions,
) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime");
  }
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocketCtor(url, {
      headers: options.headers,
    } as any);
    let opened = false;
    let aborted = options.signal?.aborted ?? false;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const clearKeepalive = () => {
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
    };
    const handleAbort = () => {
      aborted = true;
      clearKeepalive();
      try {
        ws.close();
      } catch {
        resolve();
      }
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    ws.addEventListener(
      "open",
      () => {
        opened = true;
        keepalive = setInterval(() => {
          try {
            ws.send(buildConnectorKeepaliveMessage());
          } catch {
            clearKeepalive();
          }
        }, CONNECTOR_WS_KEEPALIVE_MS);
      },
      { once: true },
    );
    ws.addEventListener("error", () => {
      clearKeepalive();
      if (aborted) {
        resolve();
        return;
      }
      reject(new Error("connector websocket failed"));
    });
    ws.addEventListener(
      "close",
      () => {
        clearKeepalive();
        if (opened || aborted) resolve();
        else reject(new Error("connector websocket closed before opening"));
      },
      { once: true },
    );
    ws.addEventListener("message", (event) => {
      const startIndex = options.sentMessages.length;
      Promise.resolve(options.onMessage(String(event.data)))
        .then(() => {
          for (const message of options.sentMessages.slice(startIndex)) {
            ws.send(message);
          }
        })
        .catch(() => undefined);
    });
  });
}

export async function runMachineWsSession(options: {
  env: EnvLike;
  output: OutputLike;
  machine: MachineHeartbeat;
  serverUrl: string;
  authToken: string;
  signal?: AbortSignal;
  sendHeartbeat: () => Promise<void>;
  runHeartbeatLoop: (options: HeartbeatLoopOptions) => Promise<void>;
  resolveConnectorWebSocketTarget: (args: {
    serverUrl: string;
    machineId: string;
    connectorSurface?: string;
    headers: Record<string, string>;
  }) => Promise<string>;
  connectWebSocket: (url: string, options: ConnectorWebSocketOptions) => Promise<void>;
  onMessage: (message: string, send: (message: string) => void) => void | Promise<void>;
}): Promise<RunMachineWsSessionResult> {
  const sentMessages: string[] = [];
  const heartbeatAbort = new AbortController();
  let heartbeatLoopPromise: Promise<void> | null = null;
  let websocketPromise: Promise<void> | null = null;
  try {
    if (options.signal?.aborted) {
      return { exitCode: 0 };
    }
    await options.sendHeartbeat();
    options.output.write(
      `Connector websocket connected: ${options.machine.name} (${options.machine.machineId})\n`
    );
    heartbeatLoopPromise = options.runHeartbeatLoop({
      intervalMs: resolveHeartbeatIntervalMs(options.env),
      sendHeartbeat: options.sendHeartbeat,
      signal: heartbeatAbort.signal,
    });
    const heartbeatMonitorPromise = heartbeatLoopPromise.then(() => {
      if (!heartbeatAbort.signal.aborted) {
        throw new Error("connector heartbeat loop ended unexpectedly");
      }
    });
    const wsTarget = await options.resolveConnectorWebSocketTarget({
      serverUrl: options.serverUrl,
      machineId: options.machine.machineId,
      connectorSurface: "cli",
      headers: { Authorization: `Bearer ${options.authToken}` },
    });
    websocketPromise = options.connectWebSocket(wsTarget, {
      headers: { Authorization: `Bearer ${options.authToken}` },
      signal: options.signal,
      sentMessages,
      onMessage: (message) =>
        options.onMessage(message, (response) => {
          sentMessages.push(response);
        }),
    });
    const abortPromise = options.signal
      ? new Promise<"aborted">((resolve) => {
          if (options.signal?.aborted) {
            resolve("aborted");
            return;
          }
          options.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
        })
      : null;
    const raceResult = await Promise.race(
      [websocketPromise, heartbeatMonitorPromise, abortPromise].filter(Boolean) as Promise<void | "aborted">[]
    );
    heartbeatAbort.abort();
    await Promise.allSettled([websocketPromise, heartbeatLoopPromise]);
    if (raceResult === "aborted") {
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  } catch (error) {
    heartbeatAbort.abort();
    await Promise.allSettled(
      [websocketPromise, heartbeatLoopPromise].filter(Boolean) as Promise<void>[],
    );
    if (isConnectorWebSocketAuthError(error)) {
      options.output.write(
        `[nolo] Connector websocket auth failed: ${error.message}. Re-register this machine or update NOLO_MACHINE_API_KEY.\n`
      );
      return { exitCode: 2 };
    }
    if (isConnectorWebSocketRetryableError(error)) {
      const description =
        error.reason === "core_draining" ? "core draining" : error.reason;
      options.output.write(
        `[nolo] Connector websocket unavailable: ${description} (${error.message}).\n`
      );
      return {
        exitCode: 1,
        retryAfterMs: error.retryAfterMs,
        reconnectReason: error.reason,
      };
    }
    options.output.write(
      `[nolo] Connector websocket failed: ${toErrorMessage(error)}\n`
    );
    return { exitCode: 1 };
  }
}
