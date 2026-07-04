import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read an env file, set or replace a variable, and write it back.
 * Preserves comments and blank lines. If the file does not exist it is created.
 */
export function upsertEnvVariable(
  filePath: string,
  key: string,
  value: string
): void {
  const normalizedPath = resolve(filePath);
  let content = "";
  if (existsSync(normalizedPath)) {
    content = readFileSync(normalizedPath, "utf8");
  }

  const lines = content.length > 0 ? content.split("\n") : [];
  const keyPrefix = `${key}=`;
  let replaced = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(keyPrefix) || trimmed.startsWith(`${key} =`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!replaced) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== "") {
      newLines.push("");
    }
    newLines.push(`${key}=${value}`);
  }

  writeFileSync(normalizedPath, newLines.join("\n"), "utf8");
}

/**
 * Parse a flag that may be followed by an optional value.
 * Returns the value string if present, true if the flag is present without a
 * value, or undefined if the flag is absent.
 */
export function parseFlagWithOptionalValue(
  args: string[],
  flag: string
): string | boolean | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (next && !next.startsWith("--")) {
    return next;
  }
  return true;
}
