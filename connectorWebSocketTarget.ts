import { isGatewayHttpStatus } from "./core/gatewayHttpStatus";
import { parseRetryAfterHeaderMs } from "./core/retryAfterMs";
import { asTrimmedLowercaseString } from "./core/trimmedLowercaseString";
import type { CliFetchImpl } from "./cliFetch";

export class ConnectorWebSocketAuthError extends Error {
  code: string;

  constructor(message: string, code = "CONNECTOR_AUTH_FAILED") {
    super(message);
    this.name = "ConnectorWebSocketAuthError";
    this.code = code;
  }
}

export function isConnectorWebSocketAuthError(error: unknown): error is ConnectorWebSocketAuthError {
  return error instanceof ConnectorWebSocketAuthError;
}

export class ConnectorWebSocketRetryableError extends Error {
  reason: string;
  retryAfterMs?: number;

  constructor(message: string, options: { reason?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ConnectorWebSocketRetryableError";
    this.reason = options.reason ?? "retryable";
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isConnectorWebSocketRetryableError(
  error: unknown
): error is ConnectorWebSocketRetryableError {
  return error instanceof ConnectorWebSocketRetryableError;
}

function parseRetryAfterMs(response: Response, bodyRetryAfterMs?: unknown) {
  const headerDelayMs = parseRetryAfterHeaderMs(response.headers.get("Retry-After"));
  if (headerDelayMs != null) return headerDelayMs;
  // Optional body ms: keep undefined when absent/invalid (no invented default).
  const parsed = Number(bodyRetryAfterMs);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

export async function resolveConnectorWebSocketTarget(input: {
  serverUrl: string;
  machineId: string;
  connectorSurface?: string;
  headers: Record<string, string>;
  fetchImpl?: CliFetchImpl;
}) {
  const directWsUrl = new URL(input.serverUrl);
  directWsUrl.protocol = directWsUrl.protocol === "https:" ? "wss:" : "ws:";
  directWsUrl.pathname = "/api/connector/ws";
  directWsUrl.search = "";
  directWsUrl.searchParams.set("machineId", input.machineId);
  const connectorSurface = asTrimmedLowercaseString(input.connectorSurface);
  if (connectorSurface) {
    directWsUrl.searchParams.set("connectorSurface", connectorSurface);
  }

  const probeUrl = new URL(input.serverUrl);
  probeUrl.pathname = "/api/connector/ws";
  probeUrl.search = directWsUrl.search;

  const response = await (input.fetchImpl ?? fetch)(probeUrl, {
    headers: input.headers,
  }).catch(() => null);

  if (response && (response.status === 401 || response.status === 403)) {
    const json = await response.json().catch(() => null);
    const code = typeof json?.code === "string" ? json.code : "CONNECTOR_AUTH_FAILED";
    const message = typeof json?.error === "string" ? json.error : `Connector auth failed with HTTP ${response.status}`;
    throw new ConnectorWebSocketAuthError(`${code}: ${message}`, code);
  }

  if (response && !response.ok) {
    const json = await response.clone().json().catch(() => null);
    const retryable =
      json?.retryable === true ||
      json?.reason === "core_draining" ||
      isGatewayHttpStatus(response.status);
    if (retryable) {
      const reason = typeof json?.reason === "string" ? json.reason : "retryable";
      const message =
        typeof json?.error === "string"
          ? json.error
          : `Connector websocket unavailable with HTTP ${response.status}`;
      throw new ConnectorWebSocketRetryableError(message, {
        reason,
        retryAfterMs: parseRetryAfterMs(response, json?.retryAfterMs),
      });
    }
  }

  if (!response || !response.ok) {
    return directWsUrl.toString();
  }

  const json = await response.json().catch(() => null);
  return typeof json?.wsUrl === "string" && json.wsUrl
    ? json.wsUrl
    : directWsUrl.toString();
}
