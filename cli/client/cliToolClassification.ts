/**
 * CLI tool classification constants.
 *
 * Extracted from localRuntimeAdapter.ts as the single source of truth for
 * "which tools belong to which category". Previously each consumer
 * (addDefaultLightWebTools, buildLocalPolicyToolNames,
 * buildServerPlatformOpenAiTools, buildOpenAiTools) re-hardcoded the same
 * name lists with slight drift. All consumers now read these sets.
 */

/** Table tools the CLI proxies to the nolo server. */
export const LOCAL_SERVER_TABLE_TOOL_NAMES = [
  "createTable",
  "addTableRow",
  "addTableRows",
  "updateTableRow",
  "updateTableRows",
] as const;
export const LOCAL_SERVER_TABLE_TOOL_NAME_SET = new Set<string>(
  LOCAL_SERVER_TABLE_TOOL_NAMES,
);

/**
 * Web access tools the CLI local runtime proxies through the nolo server
 * (same routes the desktop runtime uses: /api/fetch-webpage, /api/exa-search).
 * The CLI has no local EXA/FIRECRAWL keys, so these always bridge to a server
 * that has them configured. Requires NOLO_SERVER_URL + auth token at runtime.
 */
export const LOCAL_SERVER_WEB_TOOL_NAMES = ["fetchWebpage", "exa_search"] as const;
export const LOCAL_SERVER_WEB_TOOL_NAME_SET = new Set<string>(
  LOCAL_SERVER_WEB_TOOL_NAMES,
);

/**
 * Long-term memory tools the CLI local runtime proxies to the nolo server.
 *
 * Memory lives server-side (that is where /api/memory/query reads from), so a
 * local write would land in a store nothing ever recalls from. Bridging is the
 * only correct wiring — the read and write sides must share one store.
 *
 * Before this existed, `rememberMemory` was declared by the long-term-memory
 * capability pack but silently dropped from the CLI tool schema, so the TUI
 * could recall memories yet never write one.
 */
export const LOCAL_SERVER_MEMORY_TOOL_NAMES = [
  "queryMemory",
  "rememberMemory",
  "deleteMemory",
] as const;
export const LOCAL_SERVER_MEMORY_TOOL_NAME_SET = new Set<string>(
  LOCAL_SERVER_MEMORY_TOOL_NAMES,
);

/** Tools whose schema is injected from the nolo tool registry (not workspace). */
export const REGISTRY_INJECTED_TOOL_NAMES = new Set<string>([
  "ask_user",
  "read_x_post",
  "read_xhs_profile",
]);