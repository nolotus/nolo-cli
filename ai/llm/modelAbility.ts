// ai/llm/modelAbility.ts
//
// Minimal code-level model capability table.
// Values are 0-100 scores transcribed from benchmark screenshots.
// No composite score, no steps, no recommendedFor — just two optional numbers.

/** Optional capability metadata for a model. */
export interface ModelAbility {
  passAt1?: number;
  benchmarkScore?: number;
}

/** Canonical capability table keyed by base model name. */
// Reference scores shown to users and available as a soft selection signal;
// they are not the sole or mandatory task-routing rule. The current benchmark
// reference is pass@1 from the capability snapshot.
const MODEL_ABILITY_TABLE: Record<string, ModelAbility> = {
  "claude-opus-5": { passAt1: 74, benchmarkScore: 61 },
  "gpt-5.6-sol": { passAt1: 73, benchmarkScore: 59 },
  "claude-fable-5": { passAt1: 70 },
  "gpt-5.6-terra": { passAt1: 70, benchmarkScore: 55 },
  "kimi-k3": { passAt1: 69, benchmarkScore: 57 },
  "gpt-5.5": { passAt1: 67 },
  "gpt-5.6-luna": { passAt1: 67, benchmarkScore: 51 },
  "grok-4.6": { passAt1: 67 },
  "deepseek-v4-pro": { passAt1: 63 },
  "claude-opus-4.8": { passAt1: 59 },
  "qwen3.8-max": { passAt1: 57 },
  "muse-spark-1.2": { passAt1: 55 },
  "grok-4.5": { passAt1: 54, benchmarkScore: 54 },
  "claude-sonnet-5": { passAt1: 54, benchmarkScore: 53 },
  "deepseek-v4-flash": { passAt1: 53 },
  "muse-spark-1.1": { passAt1: 53 },
  "gpt-5.4": { passAt1: 52 },
  "gemini-3.6-flash": { passAt1: 49, benchmarkScore: 50 },
  "glm-5.2": { passAt1: 44, benchmarkScore: 51 },
};

const EFFORT_SUFFIXES = ["-extra-low", "-low", "-medium", "-high"] as const;

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
