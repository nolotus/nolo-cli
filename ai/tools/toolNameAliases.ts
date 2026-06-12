const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  createPage: "createDoc",
  updatePage: "updateDoc",
  update_page: "updateDoc",
  create_page: "createDoc",
  fetchwebpage: "fetchWebpage",
  fetch_webpage: "fetchWebpage",
  "fetch-page": "fetchWebpage",
  exasearch: "exa_search",
  "exa-search": "exa_search",
  exa_search: "exa_search",
  readDoc: "readDoc",
  readpage: "readDoc",
  read_page: "readDoc",
  read_doc: "readDoc",
  createdoc: "createDoc",
  updateDocTool: "updateDoc",
  readLocal: "readLocalFile",
  read_local: "readLocalFile",
  readLocalTool: "readLocalFile",
  listLocal: "listLocalFiles",
  list_local: "listLocalFiles",
  terminalCommand: "execShell",
  terminal_command: "execShell",
  runCommand: "execShell",
  run_command: "execShell",
  runInBash: "execShell",
  run_in_bash: "execShell",
  executeCommand: "execShell",
  execute_command: "execShell",
};

const normalizeToolName = (name: string): string =>
  name.replace(/[-_]/g, "").toLowerCase();

export const canonicalizeToolName = (rawName: string): string => {
  const trimmedName = rawName.trim();
  if (!trimmedName) return rawName;

  if (LEGACY_TOOL_NAME_ALIASES[trimmedName]) {
    return LEGACY_TOOL_NAME_ALIASES[trimmedName];
  }

  const normalizedRawName = normalizeToolName(trimmedName);
  const matchedAlias = Object.entries(LEGACY_TOOL_NAME_ALIASES).find(
    ([alias]) => normalizeToolName(alias) === normalizedRawName,
  );

  return matchedAlias?.[1] ?? trimmedName;
};

export const canonicalizeToolNames = (toolNames: string[]): string[] =>
  Array.from(
    new Set(
      toolNames
        .filter((toolName): toolName is string => typeof toolName === "string")
        .map(canonicalizeToolName),
    ),
  );

export const prioritizeToolNames = (
  toolNames: string[],
  preferredToolNames: string[],
): string[] => {
  const canonicalTools = canonicalizeToolNames(toolNames);
  const preferred = new Set(canonicalizeToolNames(preferredToolNames));
  const prioritized = canonicalTools.filter((toolName) => preferred.has(toolName));
  const remaining = canonicalTools.filter((toolName) => !preferred.has(toolName));
  return [...prioritized, ...remaining];
};
