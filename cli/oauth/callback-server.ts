import { createServer, type Server } from "node:http";

import type { OAuthCallbackResult } from "./types";

export type CallbackServerOptions = {
  port: number;
  hostname?: string;
  timeoutMs?: number;
  now?: () => number;
};

export type CallbackServerHandle = {
  server: Server;
  waitForCode(): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
};

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function parseQuery(url: string): Record<string, string> {
  const questionIndex = url.indexOf("?");
  if (questionIndex < 0) return {};
  const search = url.slice(questionIndex + 1);
  const params = new URLSearchParams(search);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization complete</title></head>
<body><h2>Authorization complete</h2><p>You can close this tab and return to the terminal.</p></body></html>`;

const ERROR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization error</title></head>
<body><h2>Authorization error</h2><p>No authorization code was received. Please try again.</p></body></html>`;

export function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServerHandle> {
  const hostname = options.hostname ?? "localhost";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return new Promise((resolve, reject) => {
    const deadline = now() + timeoutMs;
    let result: OAuthCallbackResult | null = null;
    let resultResolve: ((value: OAuthCallbackResult) => void) | null = null;
    let resultReject: ((error: Error) => void) | null = null;
    let settled = false;

    const codePromise = new Promise<OAuthCallbackResult>((res, rej) => {
      resultResolve = res;
      resultReject = rej;
    });

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`);
      server.close();
      resultReject?.(err);
    }, Math.max(0, deadline - now()));

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML);
        return;
      }
      const query = parseQuery(req.url);
      const code = query.code;
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML);
        return;
      }
      result = { code, ...(query.state ? { state: query.state } : {}) };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        server.close();
        resultResolve?.(result);
      }
    });

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      server.close();
      resultReject?.(err);
      reject(err);
    });

    server.listen(options.port, hostname, () => {
      resolve({
        server,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timeoutTimer);
          settled = true;
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
