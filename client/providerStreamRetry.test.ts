/**
 * withProviderStreamRetry — provider-level transient-failure retry.
 *
 * The integration cases spin up a REAL HTTP server and kill the TCP socket
 * mid-SSE (response headers + partial frames already delivered), which is the
 * exact production failure this wrapper exists for: Bun fetch surfaces
 * "The socket connection was closed unexpectedly" from the stream-read stage,
 * AFTER fetchWithTransientRetry has returned, so without this wrapper one
 * transient kill failed the whole agent turn.
 */
import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeResult,
} from "../agent-runtime";
import {
  readPlatformChatSseCompletion,
} from "../agent-runtime";
import { fetchWithTransientRetry } from "./localRuntimeFetchRetry";
import {
  STREAM_RETRY_MARKER,
  withProviderStreamRetry,
} from "./providerStreamRetry";

const BUN_SOCKET_CLOSED =
  "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

type DeltaSink = string[];

function makeFakeProvider(behavior: {
  attempts: Array<
    (
      deltas: (chunk: string) => void,
      options?: {
        onTextDelta?: (chunk: string) => void;
        onToolEvent?: (event: {
          type: "tool-call" | "tool-result" | "tool-error";
          round: number;
          toolCallId: string;
          toolName: string;
          argumentsPreview?: string;
          elapsedMs?: number;
          summary?: string;
          content?: string;
          message?: string;
          metadata?: Record<string, unknown>;
        }) => void;
      },
    ) => Promise<AgentRuntimeResult>
  >;
}) {
  let call = 0;
  return {
    model: "test-model",
    complete: async (
      _messages: AgentRuntimeChatMessage[],
      options?: {
        onTextDelta?: (chunk: string) => void;
        onToolEvent?: (event: {
          type: "tool-call" | "tool-result" | "tool-error";
          round: number;
          toolCallId: string;
          toolName: string;
          argumentsPreview?: string;
          elapsedMs?: number;
          summary?: string;
          content?: string;
          message?: string;
          metadata?: Record<string, unknown>;
        }) => void;
      },
    ): Promise<AgentRuntimeResult> => {
      const attempt = behavior.attempts[Math.min(call, behavior.attempts.length - 1)];
      call += 1;
      return attempt((chunk) => options?.onTextDelta?.(chunk), options);
    },
  };
}

const okResult = (content: string): AgentRuntimeResult =>
  ({ content, model: "test-model" }) as AgentRuntimeResult;

describe("withProviderStreamRetry (unit)", () => {
  it("retries a mid-stream socket death after partial output: marker + full regenerated text", async () => {
    const deltas: DeltaSink = [];
    const labels: (string | null)[] = [];
    const provider = makeFakeProvider({
      attempts: [
        async (emit) => {
          emit("Hel");
          throw new Error(BUN_SOCKET_CLOSED);
        },
        async (emit) => {
          emit("Hello, world!");
          return okResult("Hello, world!");
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {
      activityReporter: (label) => labels.push(label),
    });
    const result = await wrapped.complete([{ role: "user", content: "hi" }], {
      onTextDelta: (chunk) => deltas.push(chunk),
    });
    expect(result.content).toBe("Hello, world!");
    // Visible transcript: partial + marker + regenerated full text.
    expect(deltas.join("")).toBe(
      `Hel${STREAM_RETRY_MARKER}Hello, world!`,
    );
    expect(labels).toContain("上游流中断 · 自动重试");
  });

  it("retries silently when the failed attempt streamed nothing yet", async () => {
    const deltas: DeltaSink = [];
    const provider = makeFakeProvider({
      attempts: [
        async () => {
          throw new Error("ECONNRESET before first token");
        },
        async (emit) => {
          emit("complete answer");
          return okResult("complete answer");
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {});
    const result = await wrapped.complete([{ role: "user", content: "hi" }], {
      onTextDelta: (chunk) => deltas.push(chunk),
    });
    expect(result.content).toBe("complete answer");
    expect(deltas.join("")).not.toContain("[nolo]");
  });

  it("does NOT retry non-transient provider failures (e.g. HTTP 401)", async () => {
    let calls = 0;
    const provider = makeFakeProvider({
      attempts: [
        async () => {
          calls += 1;
          throw new Error("platform provider failed: HTTP 401 unauthorized");
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {});
    await expect(
      wrapped.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow("HTTP 401");
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget and rethrows the last transient error", async () => {
    let calls = 0;
    const provider = makeFakeProvider({
      attempts: [
        async () => {
          calls += 1;
          throw new Error(BUN_SOCKET_CLOSED);
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {});
    await expect(
      wrapped.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(BUN_SOCKET_CLOSED);
    expect(calls).toBe(2);
  });

  it("does not retry when the caller already aborted", async () => {
    let calls = 0;
    const provider = makeFakeProvider({
      attempts: [
        async () => {
          calls += 1;
          throw new Error(BUN_SOCKET_CLOSED);
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      wrapped.complete([{ role: "user", content: "hi" }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(BUN_SOCKET_CLOSED);
    expect(calls).toBe(1);
  });

  it("retries the server's structured UPSTREAM_STREAM_INTERRUPTED frame", async () => {
    const provider = makeFakeProvider({
      attempts: [
        async () => {
          throw new Error(
            'chat completion stream failed: {"message":"upstream stream interrupted: boom","code":"UPSTREAM_STREAM_INTERRUPTED"}',
          );
        },
        async (emit) => {
          emit("recovered");
          return okResult("recovered");
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {});
    const result = await wrapped.complete([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("recovered");
  });

  it("does NOT retry after mid-stream tool events: side effects are not replayable", async () => {
    let calls = 0;
    const toolEvents: string[] = [];
    const provider = makeFakeProvider({
      attempts: [
        async (_emit, opts) => {
          calls += 1;
          opts?.onToolEvent?.({
            type: "tool-call",
            round: 1,
            toolCallId: "call-1",
            toolName: "execShell",
            argumentsPreview: "rm -rf /tmp/x",
          });
          throw new Error(BUN_SOCKET_CLOSED);
        },
      ],
    });
    const wrapped = withProviderStreamRetry(provider, {});
    await expect(
      wrapped.complete([{ role: "user", content: "hi" }], {
        onToolEvent: (event) => toolEvents.push(event.toolName),
      }),
    ).rejects.toThrow(BUN_SOCKET_CLOSED);
    expect(calls).toBe(1);
    expect(toolEvents).toEqual(["execShell"]);
  });
});

describe("withProviderStreamRetry (real-socket integration)", () => {
  type ServerMode =
    | { kill: true }
    | { cleanErrorFrame: true }
    | { healthy: true };

  const startServer = () => {
    let connections = 0;
    let mode: ServerMode = { kill: true };
    const server = createServer((_req, res) => {
      connections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      if ("kill" in mode) {
        // One-shot fault: the flapping gateway recovers after the first kill,
        // so the retried attempt succeeds (mirrors a transient blip).
        mode = { healthy: true };
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if ("cleanErrorFrame" in mode) {
        mode = { healthy: true };
        res.write(
          'data: {"error":{"message":"upstream stream interrupted: gateway reset","code":"UPSTREAM_STREAM_INTERRUPTED"}}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write('data: {"choices":[{"delta":{"content":"lo, world!"}}]}\n\n');
      res.write(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":3,"total_tokens":4}}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return {
      start: async () => {
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
      },
      setMode: (next: ServerMode) => {
        mode = next;
      },
      connectionCount: () => connections,
      close: () => server.close(),
    };
  };

  /**
   * Mirrors the production platform-proxy wiring: fetch goes through
   * fetchWithTransientRetry (headers-stage retry), the SSE body read through
   * readPlatformChatSseCompletion (stream stage — the gap this wrapper fills).
   */
  const makeProductionLikeProvider = (url: string) => ({
    model: "prod-like",
    complete: async (
      _messages: AgentRuntimeChatMessage[],
      options?: { onTextDelta?: (chunk: string) => void },
    ): Promise<AgentRuntimeResult> => {
      const res = await fetchWithTransientRetry(fetch, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });
      const streamed = await readPlatformChatSseCompletion({
        response: res,
        usesResponsesApi: false,
        ...(options?.onTextDelta
          ? { onTextDelta: options.onTextDelta }
          : {}),
      });
      return {
        content: String(streamed.content ?? ""),
        model: "prod-like",
        ...(streamed.usage ? { usage: streamed.usage } : {}),
        ...(streamed.finish_reason
          ? { finish_reason: streamed.finish_reason }
          : {}),
      } as AgentRuntimeResult;
    },
  });

  it("self-heals a real mid-stream socket kill: 2 connections, marker, complete content", async () => {
    const srv = startServer();
    const url = await srv.start();
    const deltas: DeltaSink = [];
    try {
      const wrapped = withProviderStreamRetry(
        makeProductionLikeProvider(url),
        {},
      );
      const result = await wrapped.complete([{ role: "user", content: "hi" }], {
        onTextDelta: (chunk) => deltas.push(chunk),
      });
      expect(result.content).toBe("Hello, world!");
      expect(srv.connectionCount()).toBe(2);
      const visible = deltas.join("");
      expect(visible.startsWith("Hel")).toBe(true);
      expect(visible).toContain(STREAM_RETRY_MARKER);
      expect(visible.endsWith("Hello, world!")).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("retries the server's clean UPSTREAM_STREAM_INTERRUPTED error frame without a socket kill", async () => {
    const srv = startServer();
    const url = await srv.start();
    srv.setMode({ cleanErrorFrame: true });
    try {
      const wrapped = withProviderStreamRetry(
        makeProductionLikeProvider(url),
        {},
      );
      const result = await wrapped.complete([{ role: "user", content: "hi" }]);
      expect(result.content).toBe("Hello, world!");
      expect(srv.connectionCount()).toBe(2);
    } finally {
      srv.close();
    }
  });
});
