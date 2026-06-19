import { findModelConfig } from "../ai/llm/providers";

export type TurnTokenUsage = {
  input: number;
  output: number;
  contextWindow?: number;
  remaining?: number;
};

const PROVIDER_LOOKUP_ORDER = [
  "openrouter",
  "fireworks",
  "openai",
  "mimo",
  "gmi",
  "google",
  "deepseek",
  "mistral",
  "vultr",
  "deepinfra",
  "cloudflare",
] as const;

export function parseUsageRecord(usage?: Record<string, unknown> | null): TurnTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (!input && !output) return undefined;
  return { input, output };
}

export function mergeUsageRecords(
  current?: Record<string, unknown> | null,
  next?: Record<string, unknown> | null
) {
  const left = parseUsageRecord(current);
  const right = parseUsageRecord(next);
  if (!left) return right ? { input_tokens: right.input, output_tokens: right.output } : current ?? undefined;
  if (!right) return current ?? undefined;
  return {
    input_tokens: left.input + right.input,
    output_tokens: left.output + right.output,
  };
}

function fuzzyContextWindow(model: string) {
  const lower = model.toLowerCase();
  if (lower.includes("minimax-m3") || lower.includes("minimax_m3")) return 1_000_000;
  if (lower.includes("minimax-m2")) return 262_144;
  if (lower.includes("gpt-5") || lower.includes("gpt-4.1")) return 1_047_576;
  if (lower.includes("claude")) return 200_000;
  return undefined;
}

export function resolveContextWindow(model?: string) {
  const raw = model?.trim();
  if (!raw) return undefined;

  for (const provider of PROVIDER_LOOKUP_ORDER) {
    const config = findModelConfig(provider, raw);
    if (config?.contextWindow) return config.contextWindow;
  }

  return fuzzyContextWindow(raw);
}

export function buildTurnTokenUsage(
  usage?: Record<string, unknown> | null,
  model?: string
): TurnTokenUsage | undefined {
  const parsed = parseUsageRecord(usage);
  if (!parsed) return undefined;
  const contextWindow = resolveContextWindow(model);
  const remaining =
    contextWindow && parsed.input > 0
      ? Math.max(0, contextWindow - parsed.input)
      : undefined;
  return {
    ...parsed,
    ...(contextWindow ? { contextWindow } : {}),
    ...(remaining != null ? { remaining } : {}),
  };
}

export function formatTokenCount(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const compact = value / 1000;
    if (Number.isInteger(compact)) return `${compact}k`;
    return `${compact.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const compact = value / 1_000_000;
  return compact >= 100 ? `${Math.round(compact)}M` : `${compact.toFixed(1).replace(/\.0$/, "")}M`;
}

export function renderTokenStatus(tokens?: TurnTokenUsage) {
  if (!tokens) return "in — out — left —";
  const left =
    tokens.remaining != null
      ? formatTokenCount(tokens.remaining)
      : tokens.contextWindow
        ? "—"
        : "—";
  return `in ${formatTokenCount(tokens.input)} out ${formatTokenCount(tokens.output)} left ${left}`;
}