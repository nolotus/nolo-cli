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

/** Tools whose schema is injected from the nolo tool registry (not workspace). */
export const REGISTRY_INJECTED_TOOL_NAMES = new Set<string>([
  "callAgent",
  "ui_ask_choice",
  "read_x_post",
  "read_xhs_profile",
]);