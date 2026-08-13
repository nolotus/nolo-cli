/**
 * Platform-owned `searchDialogMessages` built-in skill（对话检索）。
 *
 * 背景：`searchDialogMessages` 工具原本常驻 TOOL_PACKS.CORE，所有 agent 默认
 * 必带。为收窄默认工具面，改为内置 skill——agent 在对话中按需
 * loadSkill("search-dialog-messages") 自主载入，载入后工具挂进工具面。
 *
 * 本 skill 把「对话检索」的三个工具放在一起：listDialogs（列出当前用户的
 * 对话、用于定位目标对话）、readDialog（读取对话元数据与最近消息）与
 * searchDialogMessages（在指定对话的原始消息中定点搜索）。
 * 与 codingSkills.ts / specialistSkills.ts 同构：提供 builtin 回退解析
 * （resolveSearchDialogBuiltinSlug）与无 userId 内容构建
 * （buildSearchDialogSkillContentBySlug）。内容全部来自代码，通过
 * builtinSkillRegistry 暴露给运行时，不落库。
 *
 * 边界：web 端 loadSkill 后通过 dialog.extraReferences 跨轮次扩展工具面；
 * server 端 loadSkill 只回传正文（无 extraReferences 机制），工具面是否含
 * listDialogs / readDialog / searchDialogMessages 取决于 run 开始时的工具面组成。
 */

import {
  buildSkillDocMarkdown,
  type SkillDocConfig,
} from "./skillDocProtocol";

export const SEARCH_DIALOG_SKILL_SLUGS = [
  "search-dialog-messages",
] as const;

export type SearchDialogSkillSlug =
  (typeof SEARCH_DIALOG_SKILL_SLUGS)[number];

type SearchDialogSkillSeedDef = {
  slug: SearchDialogSkillSlug;
  title: string;
  description: string;
  body: string;
  toolNames?: readonly string[];
};

/** Same FNV-1a deterministic id used by codingSkills / specialistSkills. */
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

export function buildSearchDialogSkillId(
  slug: SearchDialogSkillSlug,
): string {
  return deterministicId("01SK", normalizeSkillSeed(slug) || slug);
}

export function buildSearchDialogSkillPageKey(
  userId: string,
  slug: SearchDialogSkillSlug,
): string {
  return `page-${userId}-${buildSearchDialogSkillId(slug)}`;
}

/**
 * Authoritative search-dialog-messages skill seed（对话检索）。内容与
 * packages/ai/tools/noloWorkspaceReadTools.ts 的 listDialogs、readDialog 和
 * packages/ai/tools/searchDialogMessagesTool.ts 的 searchDialogMessages
 * 工具契约保持一致（参数、上限、返回形状），未来 skill 编辑落这里。
 */
export const SEARCH_DIALOG_SKILL_SEEDS: readonly SearchDialogSkillSeedDef[] = [
  {
    slug: "search-dialog-messages",
    title: "对话检索",
    description:
      "对话检索：listDialogs 列出当前用户的对话（默认 100 条、上限 500），用于在目标对话不明确时先定位；readDialog 读取指定对话的元数据与最近消息（dialog 优先传完整 dbKey dialog-<userId>-<id> 或对话 URL，裸 ID 仅对当前登录用户有效）；searchDialogMessages 在指定对话的原始消息中按精确或模糊文本搜索，返回匹配的 messageId、角色、裁剪后的原文片段与邻近上下文，不把整段对话灌进模型上下文。",
    body: [
      "你是「对话检索」能力的使用者：需要读取或取证某段对话时，在本 skill 的 listDialogs、readDialog 与 searchDialogMessages 三个工具中选择合适的那个。",
      "",
      "## 什么时候用",
      "- 用户要精确的旧消息、原文措辞、谁说了什么、某个决策为什么做出、早期历史细节。",
      "- 需要文件/工具证据、失败尝试、或与之前工作的对比（来自被引用对话）。",
      "- 目标对话不明确、需要先列出候选对话（当前用户的对话列表）时，用 listDialogs。",
      "- 当前上下文只有有损的对话摘要，而用户需要证据、出处或具体历史细节时——优先用本 skill，不要凭摘要猜。",
      "",
      "## listDialogs：定位对话",
      "列出当前用户的对话：`listDialogs({ limit?, space?, includeScheduled? })`。",
      "- 返回 `{ total, dialogs: [{ id, dbKey, title, status, updatedAt, createdAt, spaceId, triggerType, primaryAgentKey }] }`，按最近更新排序。",
      "- limit 控制返回条数（默认 100，上限 500）；space 可传 space id 或 URL 收窄范围；includeScheduled 控制是否包含定时/后台运行对话（默认不含）。",
      "- 目标对话不明确时先用它定位：从结果里取 dbKey 或 URL 交给 readDialog / searchDialogMessages，不要用裸 ID。",
      "",
      "## readDialog：读取对话",
      "读取指定对话的元数据与最近消息：`readDialog({ dialog: \"<dialog 的 dbKey>\" })`。",
      "- dialog 优先传完整 dbKey（dialog-<userId>-<id>）或对话 URL；裸 ID 只对当前登录用户有效，不能可靠读取其他用户或跨服务器的对话。",
      "- 目标对话不明确时，先 listDialogs 定位再读取。",
      "- limit 控制返回消息条数（默认 120，上限 1000）。",
      "",
      "## searchDialogMessages：原文搜索",
      "基本形式：`searchDialogMessages({ dialogKey: \"<dialog 的 dbKey>\", query: \"<要搜的文本>\" })`",
      "",
      "参数：",
      "- dialogKey：目标对话的 dbKey（形如 dialog-<userId>-01ABC...）。",
      "- query：要在原始消息内容里搜索的文本。",
      "- limit：最多返回多少条匹配（上限 10）。",
      "- scanLimit：从 server 拉取时最多扫描多少条消息（上限 500）。",
      "- contextMessages：每条匹配前后附带多少条邻近消息（上限 3）。",
      "- role：可选，只搜指定角色（user / assistant / tool / system）。",
      "- includeTools：可选，是否包含 tool 消息。",
      "",
      "## 返回",
      "searchDialogMessages 返回匹配的 messageId、角色、裁剪后的原文内容片段以及邻近上下文。",
      "基于返回的原文片段回答用户，引用时保持原文；片段被裁剪时，如需更完整内容再针对性缩小查询或换关键词。",
      "",
      "## 边界",
      "- searchDialogMessages 只搜**一个**指定对话的原始消息；跨对话或按主题聚合请用 queryDialogsBySubjectRef。",
      "- listDialogs 只列**当前登录用户**的对话（默认不含定时/后台运行对话，除非 includeScheduled）；跨用户/跨服务器检索不受支持。",
      "- 不要为了「多拿点上下文」而用大 scanLimit/limit 代替 readDialog 的完整读取语义；本 skill 里 readDialog 负责完整读取，searchDialogMessages 的价值是定点取证。",
      "- 搜不到时如实说明，不要用摘要或记忆编造原文。",
    ].join("\n"),
    toolNames: ["listDialogs", "readDialog", "searchDialogMessages"],
  },
];

function seedBySlug(slug: SearchDialogSkillSlug): SearchDialogSkillSeedDef {
  const seed = SEARCH_DIALOG_SKILL_SEEDS.find((item) => item.slug === slug);
  if (!seed) {
    throw new Error(`Unknown search-dialog skill slug: ${slug}`);
  }
  return seed;
}

export function buildSearchDialogSkillConfig(
  slug: SearchDialogSkillSlug,
): SkillDocConfig {
  const seed = seedBySlug(slug);
  return {
    version: "0.1",
    kind: "skill",
    id: buildSearchDialogSkillId(slug),
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
export function buildSearchDialogSkillContentBySlug(
  slug: SearchDialogSkillSlug,
): string {
  const seed = seedBySlug(slug);
  const skillConfig = buildSearchDialogSkillConfig(slug);
  return buildSkillDocMarkdown({
    body: seed.body,
    skillConfig,
  });
}

/**
 * Resolve a request name to the system-built-in search-dialog-messages skill
 * slug, or null. Shared by all hosts (web / server) so the builtin fallback
 * rule is a single source of truth.
 */
export function resolveSearchDialogBuiltinSlug(
  requestedName: string,
): SearchDialogSkillSlug | null {
  const found = SEARCH_DIALOG_SKILL_SLUGS.find(
    (slug) => slug === requestedName,
  );
  return found ?? null;
}

export type SearchDialogSkillPageRecord = {
  slug: SearchDialogSkillSlug;
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
 * Build the persisted page records for a userId (mirrors specialistSkills page
 * records). No remote I/O; used by builtinSkillRegistry and tests.
 */
export function buildSearchDialogSkillPageRecords(
  userId: string,
): SearchDialogSkillPageRecord[] {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("buildSearchDialogSkillPageRecords requires userId");
  }

  return SEARCH_DIALOG_SKILL_SEEDS.map((seed) => {
    const skillId = buildSearchDialogSkillId(seed.slug);
    const dbKey = buildSearchDialogSkillPageKey(trimmedUserId, seed.slug);
    const skillConfig = buildSearchDialogSkillConfig(seed.slug);

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
