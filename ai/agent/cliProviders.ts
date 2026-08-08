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

/**
 * CLI provider → machine capability tag required to run that CLI on a bound
 * machine. Shared by the quick-create CLI panel and AdvancedSettingsTab so the
 * machine dropdown filters identically in both surfaces.
 */
export const CLI_CAPABILITY_BY_PROVIDER: Record<CliProvider, string> = {
  copilot: "copilot-cli",
  gemini: "gemini-cli",
  codex: "codex-cli",
  claude: "claude-code",
  agy: "agy-cli",
  qoder: "qoder-cli",
  opencode: "opencode-cli",
  grok: "grok-cli",
  kimi: "kimi-cli",
};

/**
 * Display labels for the 9 CLI providers, used by both the quick-create CLI
 * panel and the AdvancedSettingsTab provider dropdown / read-only view.
 * Format follows the historical AdvancedSettingsTab wording (label + binary hint).
 */
export const CLI_PROVIDER_DISPLAY_LABELS: Record<CliProvider, string> = {
  copilot: "GitHub Copilot CLI（gh copilot）",
  gemini: "Gemini CLI（gemini）",
  codex: "OpenAI Codex CLI（codex exec）",
  claude: "Claude CLI（claude）",
  agy: "Google Antigravity CLI（agy）",
  qoder: "Qoder CLI（qoder）",
  opencode: "OpenCode CLI（opencode）",
  grok: "Grok CLI（grok）",
  kimi: "Kimi Code CLI（kimi）",
};

/**
 * Machine summary returned by GET /api/machines. Shared shape so the
 * quick-create CLI panel and AdvancedSettingsTab parse the same response.
 */
export type MachineSummary = {
  machineId: string;
  name: string;
  platform: string;
  arch: string;
  capabilities: string[];
  connectorStatus?: "connected" | "disconnected";
  status: "online" | "offline";
};

/** CLI provider dropdown options (value + display label) for quick-create. */
export const CLI_PROVIDER_OPTIONS: ReadonlyArray<{
  value: CliProvider;
  label: string;
}> = CLI_PROVIDER_VALUES.map((value) => ({
  value,
  label: CLI_PROVIDER_DISPLAY_LABELS[value],
}));
