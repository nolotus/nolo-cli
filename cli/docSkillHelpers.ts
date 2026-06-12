import {
  buildSkillDocMarkdown,
  type SkillDocConfig,
} from "../ai/skills/skillDocProtocol";
import { buildPageKey, buildPageRecord } from "./docPageHelpers";

function normalizeSkillSeed(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deterministicId(prefix: string, seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const suffix = h.toString(36).toUpperCase().padStart(14, "0");
  return (prefix + suffix).slice(0, 26);
}

export function buildSkillDocId(input: string) {
  return deterministicId("01SK", normalizeSkillSeed(input) || input);
}

export function buildSkillPageKey(userId: string, skillId: string) {
  return buildPageKey(userId, skillId);
}

export function buildSkillPageRecord(args: {
  dbKey: string;
  skillId: string;
  title: string;
  spaceId: string | null;
  body: string;
  skillConfig: SkillDocConfig;
  existing?: Record<string, any> | null;
}) {
  const { dbKey, skillId, title, spaceId, body, skillConfig, existing } = args;
  return {
    ...buildPageRecord({
      dbKey,
      pageId: skillId,
      title,
      spaceId,
      content: buildSkillDocMarkdown({
        body,
        skillConfig,
      }),
      existing,
      meta: {
        ...(existing?.meta ?? {}),
        kind: "skill",
        skillConfig,
      },
      slateData: null,
    }),
  };
}

export function parseJsonArg<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined) return fallback;
  return JSON.parse(raw) as T;
}
