import { clipCompactText } from "../core/clipCompactText";
import { asOptionalTrimmedString } from "../core/optionalString";

import { parseToolArgumentsJson } from "./parseToolArguments";

function clip(value: string, max = 240) {
  return clipCompactText(value, max);
}

/**
 * CLI/UI preview for a tool-call's JSON arguments.
 * Prefers path/command/query over dumping the raw JSON blob.
 */
export function summarizeToolArguments(
  toolName: string,
  rawArgs: string | undefined,
): string {
  void toolName;
  const args = parseToolArgumentsJson(rawArgs);
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = asOptionalTrimmedString(args[key]);
      if (value) return value;
    }
    return "";
  };
  const command = pick("command", "cmd", "runCommand", "executeCommand", "bash");
  if (command) return clip(command);
  // Prefer query before path so search previews show the pattern, not the cwd.
  const query = pick("query", "pattern", "search", "q");
  if (query) return clip(query);
  const filePath = pick("filePath", "file_path", "path", "filename", "file");
  if (filePath) return clip(filePath);
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return clip(
    keys
      .slice(0, 6)
      .map((key) => {
        const value = args[key];
        if (typeof value === "string") return `${key}=${clip(value, 80)}`;
        if (typeof value === "number" || typeof value === "boolean") {
          return `${key}=${String(value)}`;
        }
        if (Array.isArray(value)) return `${key}[${value.length}]`;
        return `${key}=${value === null ? "null" : typeof value}`;
      })
      .join(" "),
  );
}
