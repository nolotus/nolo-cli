/**
 * Server platform tool executors for CLI local runtime.
 *
 * Extracted from localRuntimeAdapter.ts. Builds executors that bridge CLI
 * local tool calls (table CRUD, web access) to the nolo server API.
 *
 * Direct imports replace lazy ensureHeavyCliLocalRuntimeModules indirection.
 */
import type { EnvLike } from "./localRuntimeHelpers";
import {
  resolveRuntimeServerUrl,
  resolveRuntimeAuthToken,
} from "./localRuntimeHelpers";
import type { CliFetchImpl } from "../cliFetch";
import { inferCaptureIntent } from "../../ai/policy/runtimePolicy";
import { parseNoloWorkspaceToolArguments } from "../../agent-runtime/noloWorkspaceTools";
import {
  LOCAL_SERVER_TABLE_TOOL_NAMES,
  LOCAL_SERVER_WEB_TOOL_NAMES,
} from "./cliToolClassification";
import {
  classifyFetchWebpageUrl,
  fetchWebpageLocally,
} from "./fetchWebpageContent";
import { fetchWithTransientRetry } from "./localRuntimeFetchRetry";

export function buildServerPlatformToolExecutors(args: {
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  /**
   * Current agent key, used to scope written memories to this agent's subject
   * (mirrors the web tool's behavior). Absent for adapters built before an
   * agent is resolved; the server then falls back to owner-level scoping.
   */
  agentKey?: string | null;
  memorySubjectId?: string | null;
}) {
  const postServer = async (
    path: string,
    body: object,
    opts?: { retryTransient?: boolean },
  ) => {
    const serverUrl = resolveRuntimeServerUrl(args.env);
    const authToken = resolveRuntimeAuthToken(args.env);
    if (!serverUrl)
      throw new Error(
        "server platform tools require NOLO_SERVER_URL, NOLO_SERVER, or BASE_URL.",
      );
    if (!authToken)
      throw new Error(
        "server platform tools require AUTH_TOKEN or NOLO_MACHINE_API_KEY.",
      );
    const url = `${serverUrl}${path}`;
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    };
    // Table and web tools surface their failure to the user, who can retry by
    // asking again. A dropped memory write is silent — nobody learns it was
    // lost — so it is the one bridge that retries. Only 429/503 are retried
    // (the upstream saying "not accepted"), so this cannot double-write.
    const response = opts?.retryTransient
      ? await fetchWithTransientRetry(args.fetchImpl, url, init)
      : await args.fetchImpl(url, init);
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `server platform tool bridge failed: HTTP ${response.status} ${text.slice(0, 500)}`,
      );
    }
    return text;
  };

  const guardExplicitTableCapture = (call: any) => {
    if (inferCaptureIntent(String(call.userInput ?? "")) === "strong")
      return null;
    return JSON.stringify({
      error: "knowledge_capture_requires_confirmation",
      message:
        "当前本地运行不允许自动写入表格。只有当用户在当前请求里明确要求保存、建表、写入 table 或做成数据集时，才能继续；否则请先询问用户。",
      policy: {
        capability: "knowledge_capture",
        target: "table",
        mode: "explicit-only-local",
      },
    });
  };

  const tableExecutors = Object.fromEntries(
    LOCAL_SERVER_TABLE_TOOL_NAMES.map((toolName) => [
      toolName,
      async (call: any) => {
        const blocked = guardExplicitTableCapture(call);
        if (blocked) {
          return {
            content: blocked,
            metadata: { serverPlatformTool: true, tableWriteBlocked: true },
          };
        }
        const parsed = parseNoloWorkspaceToolArguments(call.arguments);
        const path =
          toolName === "createTable"
            ? "/api/table/create"
            : toolName === "addTableRow"
              ? "/api/table/add-row"
              : toolName === "addTableRows"
                ? "/api/table/add-rows"
                : toolName === "updateTableRow"
                  ? "/api/table/update-row"
                  : "/api/table/update-rows";
        const content = await postServer(path, parsed);
        return {
          content,
          metadata: { serverPlatformTool: true, tableWrite: true },
        };
      },
    ]),
  );

  // Web access tools (fetchWebpage / exa_search) bridge to the same server
  // routes the desktop runtime uses. The CLI holds no local API keys, so these
  // only work when NOLO_SERVER_URL + auth are configured.
  //
  // Exception: private/loopback fetchWebpage targets must stay on-box. Bridging
  // them to the server hits the server's own SSRF guard (correctly) and would
  // never reach the user's machine. Public URLs still bridge for billing/UA.
  const webExecutors = Object.fromEntries(
    LOCAL_SERVER_WEB_TOOL_NAMES.map((toolName) => [
      toolName,
      async (call: any) => {
        const parsed = parseNoloWorkspaceToolArguments(call.arguments);
        if (toolName === "fetchWebpage") {
          const route = classifyFetchWebpageUrl(parsed.url);
          if (route.kind === "reject") {
            throw new Error(route.error);
          }
          if (route.kind === "local") {
            const content = await fetchWebpageLocally({
              url: route.url,
              fetchImpl: args.fetchImpl,
            });
            return {
              content,
              metadata: {
                serverPlatformTool: true,
                webTool: toolName,
                url: parsed.url,
                localFetch: true,
              },
            };
          }
          const content = await postServer("/api/fetch-webpage", {
            url: route.url,
          });
          return {
            content,
            metadata: {
              serverPlatformTool: true,
              webTool: toolName,
              url: parsed.url,
            },
          };
        }

        const body = {
          query: parsed.query,
          numResults: parsed.numResults ?? 5,
          useAutoprompt: parsed.useAutoprompt ?? true,
          type: parsed.type ?? "neural",
          // Model schema uses `includeContent` (boolean); the Exa API
          // expects `contents: { text: true }`. Mirror exaSearchFunc's
          // conversion so CLI proxy results match web behavior.
          contents:
            parsed.includeContent !== false ? { text: true } : undefined,
        };
        const content = await postServer("/api/exa-search", body);
        return {
          content,
          metadata: {
            serverPlatformTool: true,
            webTool: toolName,
          },
        };
      },
    ]),
  );

  const queryMemory = async (call: any) => {
    const parsed = parseNoloWorkspaceToolArguments(call.arguments);
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    if (!query) {
      return {
        content: JSON.stringify({ error: "queryMemory 需要非空 query。" }),
        metadata: { serverPlatformTool: true, memoryRead: false },
      };
    }
    const body: Record<string, unknown> = { userInput: query };
    if (args.agentKey) body.agentKey = args.agentKey;
    const memorySubjectId =
      typeof call.runtimeContext?.memorySubjectId === "string"
        ? call.runtimeContext.memorySubjectId.trim()
        : args.memorySubjectId?.trim();
    if (memorySubjectId) body.memorySubjectId = memorySubjectId;
    const raw = await postServer("/api/memory/query", body, {
      retryTransient: true,
    });
    return {
      content: raw,
      metadata: { serverPlatformTool: true, memoryRead: true },
    };
  };

  // Long-term memory writes bridge to /api/memory/remember — the same store
  // /api/memory/query recalls from. `source: agent-inferred` matches the web
  // tool: an agent deciding on its own to remember is a guess, not a user
  // directive, so it gets the lower base confidence.
  const rememberMemory = async (call: any) => {
    const parsed = parseNoloWorkspaceToolArguments(call.arguments);
    const content =
      typeof parsed.content === "string" ? parsed.content.trim() : "";
    if (!content) {
      return {
        content: JSON.stringify({
          error: "rememberMemory 需要非空 content。",
        }),
        metadata: { serverPlatformTool: true, memoryWrite: false },
      };
    }
    const body: Record<string, unknown> = {
      content,
      scope: parsed.scope ?? "auto",
      kind: parsed.kind ?? "episodic",
      source: "agent-inferred",
    };
    if (args.agentKey) body.agentKey = args.agentKey;
    const memorySubjectId =
      typeof call.runtimeContext?.memorySubjectId === "string"
        ? call.runtimeContext.memorySubjectId.trim()
        : args.memorySubjectId?.trim();
    if (memorySubjectId) body.memorySubjectId = memorySubjectId;
    const raw = await postServer("/api/memory/remember", body, {
      retryTransient: true,
    });
    return {
      content: raw,
      metadata: { serverPlatformTool: true, memoryWrite: true },
    };
  };

  return { ...tableExecutors, ...webExecutors, queryMemory, rememberMemory };
}