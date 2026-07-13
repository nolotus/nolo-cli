/**
 * Canonical CLI provider values — single browser-safe authority.
 *
 * Consumed by createAgentSchema (form), cliExecutor (runtime type),
 * agentSourceDescriptors (quick-create), and AdvancedSettingsTab (full form).
 * Keep display labels / binary hints / capability maps as view metadata elsewhere.
 * Do not import Node-only capability modules here.
 */

export const CLI_PROVIDER_VALUES = [
  "copilot",
  "gemini",
  "codex",
  "claude",
  "agy",
  "qoder",
  "opencode",
  "grok",
  "kimi",
] as const;

export type CliProvider = (typeof CLI_PROVIDER_VALUES)[number];

/** @deprecated Prefer CliProvider — same union derived from CLI_PROVIDER_VALUES. */
export type CliProviderValue = CliProvider;

export function isCliProvider(value: unknown): value is CliProvider {
  return (
    typeof value === "string" &&
    (CLI_PROVIDER_VALUES as readonly string[]).includes(value)
  );
}
