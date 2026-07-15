/**
 * Shared pure agent-handle normalizer.
 *
 * Agent lookup paths (CLI local/remote scan, server delegation tools, workspace
 * tools) match handles case-insensitively after collapsing interior whitespace.
 * Keep one definition so trim / lowercasing / space-collapse handling cannot
 * drift across CLI and agent-run modules.
 *
 * Dependency-free so pure unit tests do not pull CLI/server modules.
 */
export function normalizeAgentHandle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : undefined;
}
