import { asOptionalTrimmedString } from "../../core/optionalString";
import { asNonEmptyStringArray } from "../../core/stringArray";
import { resolvePageSkillMetadata } from "./skillDocProtocol";
import { canonicalizeToolNames } from "../tools/toolNameAliases";

export type SkillRuntimePageLike = {
  dbKey?: string;
  title?: string;
  content?: string | null;
  meta?: unknown;
  tools?: string[];
} | null;

export type PageCapabilityExtraction = {
  directTools: string[];
  hardSkillKeys: string[];
  softSkillKeys: string[];
  hardSkillTools: string[];
  softSkillHints: string[];
  promptPatches: string[];
  shouldUpgradeReference: boolean;
};

export type SkillGraphRoot = {
  identifier: string;
  mode: "required" | "recommended";
  sourceLabel?: string;
};

export type SkillGraphVisit = {
  dbKey: string;
  title?: string;
  mode: "required" | "recommended";
  sourceLabel?: string;
  meta?: ReturnType<typeof resolvePageSkillMetadata>;
};

export type ResolvedSkillGraph = {
  requiredTools: string[];
  recommendedTools: string[];
  recommendedSkillHints: string[];
  skillPromptPatches: string[];
  contentByKey: Map<string, SkillRuntimePageLike>;
  visits: SkillGraphVisit[];
};

export const joinUniqueStrings = (...groups: Array<string[] | undefined>): string[] =>
  Array.from(new Set(groups.flatMap((items) => asNonEmptyStringArray(items))));

export const extractRuntimePageCapabilities = (
  content: SkillRuntimePageLike,
): PageCapabilityExtraction => {
  const meta = resolvePageSkillMetadata(content);
  const directTools = asNonEmptyStringArray(content?.tools);
  const skillConfig = meta?.skillConfig;
  const skillTools = skillConfig?.toolNames ?? [];
  const softSkillHints = asNonEmptyStringArray([
    skillConfig?.name,
    ...(meta?.recommendedSkills ?? []),
  ]);

  return {
    directTools,
    hardSkillKeys: meta?.requiredSkills ?? [],
    softSkillKeys: meta?.recommendedSkills ?? [],
    hardSkillTools: meta?.kind === "skill" ? skillTools : [],
    softSkillHints,
    promptPatches: skillConfig?.promptPatch ? [skillConfig.promptPatch] : [],
    shouldUpgradeReference:
      directTools.length > 0 || meta?.kind === "skill" || !!skillConfig?.promptPatch,
  };
};

export const buildSkillGuidancePromptBlock = (options: {
  title?: string;
  recommendedSkillHints?: string[];
  skillPromptPatches?: string[];
}): string => {
  const title = asOptionalTrimmedString(options.title) ?? "--- 技能提示 ---";
  const recommendedSkillHints = joinUniqueStrings(options.recommendedSkillHints);
  const skillPromptPatches = joinUniqueStrings(options.skillPromptPatches);

  if (recommendedSkillHints.length === 0 && skillPromptPatches.length === 0) {
    return "";
  }

  return [
    title,
    recommendedSkillHints.length > 0
      ? `以下技能与当前任务更相关，可优先考虑：${recommendedSkillHints.join("、")}`
      : "",
    ...skillPromptPatches,
  ]
    .filter(Boolean)
    .join("\n");
};

export const buildReferenceRuntimePromptBlock = (visits: SkillGraphVisit[], skillPromptPatches: string[]): string => {
  const referenceLines = new Set<string>();
  const hardSkillNames = new Set<string>();
  const softSkillNames = new Set<string>();
  const promptSections: string[] = [];

  for (const visit of visits) {
    const line =
      visit.sourceLabel && visit.sourceLabel !== visit.dbKey
        ? `${visit.title ?? visit.dbKey} (${visit.dbKey}) <- ${visit.sourceLabel}`
        : `${visit.title ?? visit.dbKey} (${visit.dbKey})`;
    referenceLines.add(line);
    const skillName = visit.meta?.skillConfig?.name;
    if (!skillName) continue;
    if (visit.mode === "required") hardSkillNames.add(skillName);
    else softSkillNames.add(skillName);
  }

  if (referenceLines.size > 0) {
    promptSections.push(
      [
        "你当前挂载了这些 references，可按需直接读取它们的 dbKey：",
        ...Array.from(referenceLines).map((line) => `- ${line}`),
      ].join("\n"),
    );
  }
  if (hardSkillNames.size > 0) {
    promptSections.push(
      ["这些技能已硬加载，可直接使用相关能力：", ...Array.from(hardSkillNames).map((name) => `- ${name}`)].join("\n"),
    );
  }
  if (softSkillNames.size > 0) {
    promptSections.push(
      ["这些技能只是推荐候选，不是必须执行：", ...Array.from(softSkillNames).map((name) => `- ${name}`)].join("\n"),
    );
  }

  const skillGuidanceBlock = buildSkillGuidancePromptBlock({
    title: "技能补充指令：",
    skillPromptPatches,
  });
  if (skillGuidanceBlock) {
    promptSections.push(skillGuidanceBlock);
  }

  return promptSections.length > 0 ? promptSections.join("\n\n") : "";
};

const buildIdentifierCandidates = (
  identifier: string,
  contentByKey: Map<string, SkillRuntimePageLike>,
): string => {
  const trimmed = identifier.trim();
  if (!trimmed || contentByKey.has(trimmed)) return trimmed;

  const candidateToKey = new Map<string, string>();
  for (const [key, page] of Array.from(contentByKey.entries())) {
    const meta = resolvePageSkillMetadata(page);
    for (const value of [key, page?.dbKey, page?.title, meta?.skillConfig?.id, meta?.skillConfig?.name]) {
      const trimmedValue = asOptionalTrimmedString(value);
      if (trimmedValue) {
        candidateToKey.set(trimmedValue, key);
      }
    }
  }

  return candidateToKey.get(trimmed) ?? trimmed;
};

export async function resolveSkillGraphFromRoots(options: {
  roots: SkillGraphRoot[];
  loadPage: (identifier: string) => Promise<SkillRuntimePageLike>;
  contentByKey?: Map<string, SkillRuntimePageLike>;
}): Promise<ResolvedSkillGraph> {
  const contentByKey = new Map<string, SkillRuntimePageLike>(options.contentByKey ?? []);
  const requiredTools = new Set<string>();
  const recommendedTools = new Set<string>();
  const recommendedSkillHints = new Set<string>();
  const skillPromptPatches = new Set<string>();
  const visits: SkillGraphVisit[] = [];
  const visited = new Set<string>();

  const loadPageCached = async (identifier: string): Promise<SkillRuntimePageLike> => {
    const resolvedIdentifier = buildIdentifierCandidates(identifier, contentByKey);
    if (!resolvedIdentifier) return null;
    if (contentByKey.has(resolvedIdentifier)) {
      return contentByKey.get(resolvedIdentifier) ?? null;
    }

    const page = await options.loadPage(resolvedIdentifier);
    if (page) {
      contentByKey.set(resolvedIdentifier, page);
      if (page.dbKey) {
        contentByKey.set(page.dbKey, page);
      }
    }
    return page ?? null;
  };

  const visit = async (
    identifier: string,
    mode: "required" | "recommended",
    sourceLabel?: string,
  ): Promise<void> => {
    const page = await loadPageCached(identifier);
    if (!page?.dbKey) return;
    const visitKey = `${mode}:${page.dbKey}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const meta = resolvePageSkillMetadata(page);
    const directTools = canonicalizeToolNames(page.tools ?? []);
    const skillTools = canonicalizeToolNames(meta?.skillConfig?.toolNames ?? []);
    const mergedTools = joinUniqueStrings(directTools, skillTools);

    visits.push({
      dbKey: page.dbKey,
      title: page.title,
      mode,
      sourceLabel,
      meta,
    });

    if (mode === "required") {
      mergedTools.forEach((toolName) => requiredTools.add(toolName));
      if (meta?.skillConfig?.promptPatch) {
        skillPromptPatches.add(meta.skillConfig.promptPatch);
      }
    } else {
      mergedTools.forEach((toolName) => recommendedTools.add(toolName));
      if (meta?.skillConfig?.name) {
        recommendedSkillHints.add(meta.skillConfig.name);
      }
    }

    const nextHard = meta?.requiredSkills ?? meta?.skillConfig?.requiredSkills ?? [];
    const nextSoft = meta?.recommendedSkills ?? meta?.skillConfig?.recommendedSkills ?? [];

    if (mode === "required") {
      await Promise.all(nextHard.map((childKey) => visit(childKey, "required", page.dbKey)));
      await Promise.all(nextSoft.map((childKey) => visit(childKey, "recommended", page.dbKey)));
      return;
    }

    await Promise.all([...nextHard, ...nextSoft].map((childKey) => visit(childKey, "recommended", page.dbKey)));
  };

  await Promise.all(options.roots.map((root) => visit(root.identifier, root.mode, root.sourceLabel)));

  return {
    requiredTools: Array.from(requiredTools),
    recommendedTools: Array.from(recommendedTools),
    recommendedSkillHints: Array.from(recommendedSkillHints),
    skillPromptPatches: Array.from(skillPromptPatches),
    contentByKey,
    visits,
  };
}
