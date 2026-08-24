// ai/llm/modelAbility.ts
//
// Minimal code-level model capability table.
// Values are 0-100 scores transcribed from benchmark snapshots and domain evaluations.
// No composite score, no steps, no recommendedFor — just optional numeric capability signals.

/** Optional capability metadata for a model. */
export interface ModelAbility {
  passAt1?: number;
  benchmarkScore?: number;
  writingScore?: number;
}

/** Canonical capability table keyed by base model name. */
// Reference scores shown to users and available as a soft selection signal;
// they are not the sole or mandatory task-routing rule. The current benchmark
// reference includes pass@1, benchmarkScore and domain writingScore.
const MODEL_ABILITY_TABLE: Record<string, ModelAbility> = {
  "claude-opus-5": { passAt1: 74, benchmarkScore: 61, writingScore: 82 },
  "claude-opus-4-6": { passAt1: 65, benchmarkScore: 68, writingScore: 78 },
  "gpt-5.6-sol": { passAt1: 73, benchmarkScore: 59, writingScore: 80 },
  "claude-fable-5": { passAt1: 70 },
  "gpt-5.6-terra": { passAt1: 70, benchmarkScore: 55 },
  "kimi-k3": { passAt1: 69, benchmarkScore: 57, writingScore: 81 },
  "gpt-5.5": { passAt1: 67 },
  "gpt-5.6-luna": { passAt1: 67, benchmarkScore: 51 },
  "grok-4.6": { passAt1: 67 },
  "deepseek-v4-pro": { passAt1: 63, writingScore: 79 },
  "qwen3.8-max": { passAt1: 57, writingScore: 77 },
  "muse-spark-1.2": { passAt1: 55 },
  "grok-4.5": { passAt1: 54, benchmarkScore: 54 },
  "claude-sonnet-5": { passAt1: 54, benchmarkScore: 53 },
  "deepseek-v4-flash": { passAt1: 53 },
  "gemini-3.7-flash": { passAt1: 58, benchmarkScore: 65, writingScore: 88 },
  "muse-spark-1.1": { passAt1: 53 },
  "gpt-5.4": { passAt1: 52 },
  "gemini-3.6-flash": { passAt1: 49, benchmarkScore: 50 },
  "glm-5.3": { passAt1: 52, benchmarkScore: 60 },
  "glm-5.2": { passAt1: 44, benchmarkScore: 51 },
};

const EFFORT_SUFFIXES = [
  "-extra-low",
  "-low",
  "-medium",
  "-high",
  "-thinking",
  "-tiered",
  ":cloud",
] as const;

/** Normalize provider-prefixed and effort-suffixed model ids to their base name. */
export function normalizeModelName(raw: string): string {
  let name = raw.trim().toLowerCase();
  const slash = name.indexOf("/");
  if (slash !== -1) name = name.slice(slash + 1);

  for (const suffix of EFFORT_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }

  return name;
}

/** Resolve capability metadata; unknown models intentionally return undefined. */
export function getModelAbility(modelName: string): ModelAbility | undefined {
  const entry = MODEL_ABILITY_TABLE[normalizeModelName(modelName)];
  return entry ? { ...entry } : undefined;
}
