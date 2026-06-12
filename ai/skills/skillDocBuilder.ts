import {
  buildSkillDocMarkdown,
  type SkillBudgetTier,
  type SkillDocConfig,
  type SkillEvalCase,
  type SkillEvalConfig,
  type SkillModality,
} from "./skillDocProtocol";
import { canonicalizeToolNames } from "../tools/toolNameAliases";

export interface CreateSkillDocArgs {
  title?: string;
  name?: string;
  description: string;
  body?: string;
  toolNames?: string[];
  requiredSkills?: string[];
  recommendedSkills?: string[];
  promptPatch?: string;
  budgetTier?: SkillBudgetTier;
  dispatchPreferred?: boolean;
  modalities?: SkillModality[];
  preferredAgents?: string[];
  discoverKeywords?: string[];
  discoverExamples?: string[];
  evalCases?: SkillEvalCase[];
}

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
};

const normalizeEvalCases = (value: unknown): SkillEvalCase[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is SkillEvalCase => !!item && typeof item === "object")
    .map((item) => ({
      input: typeof item.input === "string" ? item.input.trim() : "",
      expectedTools: normalizeStringArray(item.expectedTools),
      expectedSignals: normalizeStringArray(item.expectedSignals),
      forbiddenSignals: normalizeStringArray(item.forbiddenSignals),
    }))
    .filter((item) => item.input);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeModalities = (value: unknown): SkillModality[] | undefined => {
  const normalized = normalizeStringArray(value);
  if (!normalized) return undefined;
  const filtered = normalized.filter(
    (item): item is SkillModality =>
      item === "text" ||
      item === "image" ||
      item === "video" ||
      item === "audio" ||
      item === "3d"
  );
  return filtered.length > 0 ? filtered : undefined;
};

const normalizeBudgetTier = (value: unknown): SkillBudgetTier | undefined =>
  value === "low" || value === "medium" || value === "high" ? value : undefined;

export const buildSkillDocFromArgs = (
  args: CreateSkillDocArgs
): {
  title: string;
  content: string;
  skillConfig: SkillDocConfig;
  evalConfig?: SkillEvalConfig;
} => {
  const rawTitle = (args.title ?? "").trim();
  const rawName = (args.name ?? "").trim();
  const title = rawTitle || rawName || "New Skill";
  const name = rawName || title;
  const description = (args.description ?? "").trim();
  if (!description) {
    throw new Error("createSkillDoc 需要 description。");
  }

  const skillConfig: SkillDocConfig = {
    version: "0.1",
    kind: "skill",
    id: slugify(name),
    name,
    description,
    triggerMode: "explicit",
    toolNames: canonicalizeToolNames(normalizeStringArray(args.toolNames) ?? []),
    requiredSkills: normalizeStringArray(args.requiredSkills),
    recommendedSkills: normalizeStringArray(args.recommendedSkills),
    promptPatch:
      typeof args.promptPatch === "string" && args.promptPatch.trim()
        ? args.promptPatch.trim()
        : undefined,
    budgetTier: normalizeBudgetTier(args.budgetTier) ?? "medium",
    dispatchPreferred: args.dispatchPreferred === true,
    modalities: normalizeModalities(args.modalities) ?? ["text"],
    preferredAgents: normalizeStringArray(args.preferredAgents),
    discover:
      normalizeStringArray(args.discoverKeywords)?.length ||
      normalizeStringArray(args.discoverExamples)?.length
        ? {
            keywords: normalizeStringArray(args.discoverKeywords),
            examples: normalizeStringArray(args.discoverExamples),
          }
        : undefined,
  };

  const evalCases = normalizeEvalCases(args.evalCases);
  const evalConfig = evalCases
    ? {
        version: "0.1" as const,
        cases: evalCases,
      }
    : undefined;

  return {
    title,
    skillConfig,
    evalConfig,
    content: buildSkillDocMarkdown({
      body: (args.body ?? "").trim(),
      skillConfig,
      evalConfig,
    }),
  };
};
