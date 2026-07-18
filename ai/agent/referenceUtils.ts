import type { AppDispatch } from "../../app/store";
import type { ReferenceItem } from "../../app/types";
import { read } from "../../database/dbSlice";
import {
  extractRuntimePageCapabilities,
  resolveSkillGraphFromRoots,
  type SkillRuntimePageLike,
} from "../skills/referenceRuntime";

export function mergeReferences(
  base?: ReferenceItem[] | null,
  extra?: ReferenceItem[] | null
): ReferenceItem[] {
  const safeBase = Array.isArray(base) ? base : [];
  const safeExtra = Array.isArray(extra) ? extra : [];

  const seen = new Set<string>();
  const merged: ReferenceItem[] = [];

  for (const item of [...safeBase, ...safeExtra]) {
    const key = item.dbKey;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(item);
  }

  return merged;
}

export type ResolvedReferenceAssets = {
  references: ReferenceItem[];
  referencedTools: string[];
  recommendedSkillTools: string[];
  recommendedSkillHints: string[];
  skillPromptPatches: string[];
  contentByKey: Map<string, any>;
};

export type ResolvedContentTools = {
  tools: string[];
  recommendedSkillTools: string[];
  recommendedSkillHints: string[];
  skillPromptPatches: string[];
  contentByKey: Map<string, any>;
};

const loadContentsByKeys = async (
  keys: string[],
  dispatch: AppDispatch,
  preloaded?: Map<string, any>
): Promise<Map<string, any>> => {
  const contentByKey = new Map<string, SkillRuntimePageLike>();
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  await Promise.all(
    uniqueKeys.map(async (dbKey) => {
      if (preloaded?.has(dbKey)) {
        const content = preloaded.get(dbKey);
        if (content) contentByKey.set(dbKey, content);
        return;
      }
      try {
        const content = await dispatch(read({ dbKey })).unwrap();
        if (content) contentByKey.set(dbKey, content);
      } catch {
        // ignore missing content
      }
    })
  );
  return contentByKey;
};

export const resolveReferenceAssets = async (
references: ReferenceItem[] | undefined,
dispatch: AppDispatch)
: Promise<ResolvedReferenceAssets> => {
  if (!Array.isArray(references) || references.length === 0) {
    return {
      references: [],
      referencedTools: [],
      recommendedSkillTools: [],
      recommendedSkillHints: [],
      skillPromptPatches: [],
      contentByKey: new Map(),
    };
  }

  const entries = await Promise.all(
    references.
    filter((ref) => ref?.dbKey).
    map(async (ref) => {
      try {
        const content = await dispatch(read({ dbKey: ref.dbKey })).unwrap();
        return { ref, content };
      } catch {
        return { ref, content: null };
      }
    })
  );

  const contentByKey = new Map<string, any>();
  const toolSet = new Set<string>();
  const recommendedToolSet = new Set<string>();
  const recommendedSkillHints = new Set<string>();
  const skillPromptPatches = new Set<string>();
  const normalizedReferences: ReferenceItem[] = [];
  const hardSkillKeys = new Set<string>();
  const softSkillKeys = new Set<string>();

  for (const { ref, content } of entries) {
    if (content) {
      contentByKey.set(ref.dbKey, content);
    }

    const capabilities = extractRuntimePageCapabilities(content);
    for (const tool of capabilities.directTools) {
      toolSet.add(tool);
    }
    for (const tool of capabilities.hardSkillTools) {
      toolSet.add(tool);
    }
    for (const hint of capabilities.softSkillHints) {
      recommendedSkillHints.add(hint);
    }
    for (const patch of capabilities.promptPatches) {
      skillPromptPatches.add(patch);
    }
    for (const skillKey of capabilities.hardSkillKeys) {
      hardSkillKeys.add(skillKey);
    }
    for (const skillKey of capabilities.softSkillKeys) {
      softSkillKeys.add(skillKey);
    }

    normalizedReferences.push({
      ...ref,
      type: capabilities.shouldUpgradeReference ? "instruction" : ref.type,
    });
  }

  const resolvedSkillLinks = await resolveSkillGraphFromRoots({
    roots: [
      ...Array.from(hardSkillKeys).map((identifier) => ({ identifier, mode: "required" as const })),
      ...Array.from(softSkillKeys).map((identifier) => ({ identifier, mode: "recommended" as const })),
    ],
    loadPage: async (identifier) => {
      const loaded = await loadContentsByKeys([identifier], dispatch, contentByKey);
      return loaded.get(identifier) ?? null;
    },
    contentByKey,
  });
  resolvedSkillLinks.contentByKey.forEach((value, key) => contentByKey.set(key, value));
  for (const tool of resolvedSkillLinks.requiredTools) {
    toolSet.add(tool);
  }
  for (const tool of resolvedSkillLinks.recommendedTools) {
    recommendedToolSet.add(tool);
  }
  for (const hint of resolvedSkillLinks.recommendedSkillHints) {
    recommendedSkillHints.add(hint);
  }
  for (const patch of resolvedSkillLinks.skillPromptPatches) {
    skillPromptPatches.add(patch);
  }

  return {
    references: normalizedReferences,
    referencedTools: Array.from(toolSet),
    recommendedSkillTools: Array.from(recommendedToolSet),
    recommendedSkillHints: Array.from(recommendedSkillHints),
    skillPromptPatches: Array.from(skillPromptPatches),
    contentByKey
  };
};

export const resolveToolsFromKeys = async (
keys: string[],
dispatch: AppDispatch,
preloaded?: Map<string, any>)
: Promise<ResolvedContentTools> => {
  if (!Array.isArray(keys) || keys.length === 0) {
    return {
      tools: [],
      recommendedSkillTools: [],
      recommendedSkillHints: [],
      skillPromptPatches: [],
      contentByKey: new Map(),
    };
  }

  const contentByKey = await loadContentsByKeys(keys, dispatch, preloaded);
  const toolSet = new Set<string>();
  const recommendedToolSet = new Set<string>();
  const recommendedSkillHints = new Set<string>();
  const skillPromptPatches = new Set<string>();
  const hardSkillKeys = new Set<string>();
  const softSkillKeys = new Set<string>();

  for (const content of contentByKey.values()) {
    const capabilities = extractRuntimePageCapabilities(content);
    for (const tool of [...capabilities.directTools, ...capabilities.hardSkillTools]) {
      toolSet.add(tool);
    }
    for (const hint of capabilities.softSkillHints) {
      recommendedSkillHints.add(hint);
    }
    for (const patch of capabilities.promptPatches) {
      skillPromptPatches.add(patch);
    }
    for (const skillKey of capabilities.hardSkillKeys) {
      hardSkillKeys.add(skillKey);
    }
    for (const skillKey of capabilities.softSkillKeys) {
      softSkillKeys.add(skillKey);
    }
  }

  const resolvedSkillLinks = await resolveSkillGraphFromRoots({
    roots: [
      ...Array.from(hardSkillKeys).map((identifier) => ({ identifier, mode: "required" as const })),
      ...Array.from(softSkillKeys).map((identifier) => ({ identifier, mode: "recommended" as const })),
    ],
    loadPage: async (identifier) => {
      const loaded = await loadContentsByKeys([identifier], dispatch, contentByKey);
      return loaded.get(identifier) ?? null;
    },
    contentByKey,
  });
  resolvedSkillLinks.contentByKey.forEach((value, key) => contentByKey.set(key, value));
  for (const tool of resolvedSkillLinks.requiredTools) {
    toolSet.add(tool);
  }
  for (const tool of resolvedSkillLinks.recommendedTools) {
    recommendedToolSet.add(tool);
  }
  for (const hint of resolvedSkillLinks.recommendedSkillHints) {
    recommendedSkillHints.add(hint);
  }
  for (const patch of resolvedSkillLinks.skillPromptPatches) {
    skillPromptPatches.add(patch);
  }

  return {
    tools: Array.from(toolSet),
    recommendedSkillTools: Array.from(recommendedToolSet),
    recommendedSkillHints: Array.from(recommendedSkillHints),
    skillPromptPatches: Array.from(skillPromptPatches),
    contentByKey
  };
};
