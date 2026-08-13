/**
 * Platform-owned `search-all-spaces` built-in skill（全空间搜索）。
 *
 * 背景：`search_all_spaces` 工具原本常驻 TOOL_PACKS.CORE，所有 agent 默认必带。
 * 为收窄默认工具面，改为内置 skill——agent 在对话中按需 loadSkill("search-all-spaces")
 * 自主载入，载入后工具才挂进工具面。与 searchDialogSkill.ts 同构：提供 builtin
 * 回退解析（resolveSearchSpaceBuiltinSlug）与无 userId 内容构建
 * （buildSearchSpaceSkillContentBySlug）。内容全部来自代码，通过
 * builtinSkillRegistry 暴露给运行时，不落库。
 *
 * 边界：web 端 loadSkill 后通过 dialog.extraReferences 跨轮次扩展工具面；
 * server 端 loadSkill 只回传正文（无 extraReferences 机制），工具面是否含
 * search_all_spaces 取决于 run 开始时的工具面组成。
 *
 * 与 search_workspace 的关系：search_workspace 仍随 CORE 常驻（分类视图的
 * 「当前空间」检索）；本 skill 只收编全空间检索那一半。全部视图（All View）
 * 没有「当前空间」语义，运行时不再自动注入 search_all_spaces，而是通过
 * recommended skill hint 提示模型按需 loadSkill 本 skill。
 */

import {
  buildSkillDocMarkdown,
  type SkillDocConfig,
} from "./skillDocProtocol";

export const SEARCH_SPACE_SKILL_SLUGS = [
  "search-all-spaces",
] as const;

export type SearchSpaceSkillSlug = (typeof SEARCH_SPACE_SKILL_SLUGS)[number];

type SearchSpaceSkillSeedDef = {
  slug: SearchSpaceSkillSlug;
  title: string;
  description: string;
  body: string;
  toolNames?: readonly string[];
};

/** Same FNV-1a deterministic id used by codingSkills / specialistSkills / searchDialogSkill. */
function deterministicId(prefix: string, seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const suffix = h.toString(36).toUpperCase().padStart(14, "0");
  return (prefix + suffix).slice(0, 26);
}

function normalizeSkillSeed(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildSearchSpaceSkillId(
  slug: SearchSpaceSkillSlug,
): string {
  return deterministicId("01SK", normalizeSkillSeed(slug) || slug);
}

export function buildSearchSpaceSkillPageKey(
  userId: string,
  slug: SearchSpaceSkillSlug,
): string {
  return `page-${userId}-${buildSearchSpaceSkillId(slug)}`;
}

/**
 * Authoritative search-all-spaces skill seed（全空间搜索）。内容与
 * packages/ai/tools/searchWorkspaceTool.ts 的 search_all_spaces 工具契约保持
 * 一致（参数、返回形状、与「全部视图 Recent」共享的同步数据语义），未来 skill
 * 编辑落这里。
 */
export const SEARCH_SPACE_SKILL_SEEDS: readonly SearchSpaceSkillSeedDef[] = [
  {
    slug: "search-all-spaces",
    title: "全空间搜索",
    description:
      "全空间搜索：使用 search_all_spaces 在当前设备已同步的全部内容中搜索当前用户的数据（等同于全部视图 Recent 的内容语义），并返回所属空间（如有）。适合在全部视图（All View）或需要跨空间检索时使用。",
    body: [
      "你是「全空间搜索」能力的使用者：需要跨空间、或在没有「当前空间」语义的上下文中检索用户内容时，使用本 skill 的 search_all_spaces 工具。",
      "",
      "## 什么时候用",
      "- 用户要跨空间查找内容（页面、表格、对话等），且不限定在某个具体空间。",
      "- 当前视图是全部视图（All View）：没有当前空间，search_workspace 不适用，优先用本 skill。",
      "- 需要确认某条内容属于哪个空间（返回结果带 spaceId / spaceName）时。",
      "",
      "## 调用方式",
      "`search_all_spaces({ query: \"<关键词>\" })`",
      "- query：搜索关键词，匹配标题与文件名（contentKey）。",
      "- 返回 rawData.contents：每项包含 title、type、contentKey、spaceId、spaceName（如有）、createdAt / updatedAt、serverOrigin（如有）。",
      "",
      "## 语义与边界",
      "- 搜索范围 = 当前设备已同步的 user-data 内容（与「全部视图 Recent」同一套语义），不是远程数据库的全量检索。",
      "- 结果可能跨多个空间，按内容逐条返回，不需要在返回后二次搜索。",
      "- 没有命中时如实说明，不要编造内容或空间归属。",
      "- 分类视图（categories）下用户只问当前空间内容时，优先用常驻的 search_workspace；需要跨空间才 loadSkill 本 skill。",
    ].join("\n"),
    toolNames: ["search_all_spaces"],
  },
];

function seedBySlug(slug: SearchSpaceSkillSlug): SearchSpaceSkillSeedDef {
  const seed = SEARCH_SPACE_SKILL_SEEDS.find((item) => item.slug === slug);
  if (!seed) {
    throw new Error(`Unknown search-space skill slug: ${slug}`);
  }
  return seed;
}

export function buildSearchSpaceSkillConfig(
  slug: SearchSpaceSkillSlug,
): SkillDocConfig {
  const seed = seedBySlug(slug);
  return {
    version: "0.1",
    kind: "skill",
    id: buildSearchSpaceSkillId(slug),
    name: seed.title,
    description: seed.description,
    ...(seed.toolNames?.length ? { toolNames: [...seed.toolNames] } : {}),
  };
}

/**
 * Build the skill's markdown content by slug, without a userId. Used by hosts
 * that have no DB access (e.g. server loadSkill fallback) to return the
 * system-built-in content when no matching space page exists.
 */
export function buildSearchSpaceSkillContentBySlug(
  slug: SearchSpaceSkillSlug,
): string {
  const seed = seedBySlug(slug);
  const skillConfig = buildSearchSpaceSkillConfig(slug);
  return buildSkillDocMarkdown({
    body: seed.body,
    skillConfig,
  });
}

/**
 * Resolve a request name to the system-built-in search-all-spaces skill slug,
 * or null. Shared by all hosts (web / server) so the builtin fallback rule is
 * a single source of truth.
 */
export function resolveSearchSpaceBuiltinSlug(
  requestedName: string,
): SearchSpaceSkillSlug | null {
  const found = SEARCH_SPACE_SKILL_SLUGS.find(
    (slug) => slug === requestedName,
  );
  return found ?? null;
}

export type SearchSpaceSkillPageRecord = {
  slug: SearchSpaceSkillSlug;
  skillId: string;
  dbKey: string;
  title: string;
  content: string;
  meta: {
    kind: "skill";
    skillConfig: SkillDocConfig;
  };
  tools?: string[];
};

/**
 * Build the persisted page records for a userId (mirrors searchDialogSkill page
 * records). No remote I/O; used by builtinSkillRegistry and tests.
 */
export function buildSearchSpaceSkillPageRecords(
  userId: string,
): SearchSpaceSkillPageRecord[] {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("buildSearchSpaceSkillPageRecords requires userId");
  }

  return SEARCH_SPACE_SKILL_SEEDS.map((seed) => {
    const skillId = buildSearchSpaceSkillId(seed.slug);
    const dbKey = buildSearchSpaceSkillPageKey(trimmedUserId, seed.slug);
    const skillConfig = buildSearchSpaceSkillConfig(seed.slug);

    return {
      slug: seed.slug,
      skillId,
      dbKey,
      title: seed.title,
      content: buildSkillDocMarkdown({
        body: seed.body,
        skillConfig,
      }),
      meta: {
        kind: "skill",
        skillConfig,
      },
      ...(skillConfig.toolNames?.length ? { tools: [...skillConfig.toolNames] } : {}),
    };
  });
}
