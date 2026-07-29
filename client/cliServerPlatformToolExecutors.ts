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
import { inferCaptureIntent } from "../ai/policy/runtimePolicy";
import { parseNoloWorkspaceToolArguments } from "../agent-runtime/noloWorkspaceTools";
import {
  LOCAL_SERVER_TABLE_TOOL_NAMES,
  LOCAL_SERVER_WEB_TOOL_NAMES,
} from "./cliToolClassification";

export function buildServerPlatformToolExecutors(args: {
  env: EnvLike;
  fetchImpl: CliFetchImpl;
}) {
  const postServer = async (path: string, body: object) => {
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
    const response = await args.fetchImpl(`${serverUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
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
  const webExecutors = Object.fromEntries(
    LOCAL_SERVER_WEB_TOOL_NAMES.map((toolName) => [
      toolName,
      async (call: any) => {
        const parsed = parseNoloWorkspaceToolArguments(call.arguments);
        const path =
          toolName === "fetchWebpage" ? "/api/fetch-webpage" : "/api/exa-search";
        const body =
          toolName === "fetchWebpage"
            ? { url: parsed.url }
            : {
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
        const content = await postServer(path, body);
        return {
          content,
          metadata: {
            serverPlatformTool: true,
            webTool: toolName,
            ...(toolName === "fetchWebpage" || toolName === "fetch_webpage"
              ? { url: parsed.url }
              : {}),
          },
        };
      },
    ]),
  );

  return { ...tableExecutors, ...webExecutors };
}