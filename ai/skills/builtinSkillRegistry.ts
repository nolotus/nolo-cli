/**
 * 内置 skill 注册表：平台自带 skill 的**唯一真相源**，内容全部来自代码。
 *
 * 解决的问题
 * ----------
 * skill 图解析器（`resolveSkillGraphFromRoots`）本身不碰数据库——页面从哪来由
 * 调用方的 `loadPage` 决定。但 web 端的引用解析（`referenceUtils`）只会
 * `read(dbKey)`，于是代码里明明有内容的内置 skill，也必须先往 DB 写一份
 * 「物化副本」，`dialog.extraReferences` 才能在下一轮解析出工具面。
 *
 * 后果有三：
 *   1. 同一段「先 ensure 落库、再写 reference」的 best-effort 绕行被逐个 skill
 *      复制（coding 一份、specialist 一份，下一个就是第三份）；
 *   2. 落库失败时工具面静默不扩展，用户只看到 skill 正文但 agent 用不了工具；
 *   3. DB 副本会相对代码变旧——数据漂移，正是系统层 skill 最不该有的东西。
 *
 * 本注册表把这三条一次性去掉：内置 skill 按 slug / skillId / 页面 key 都能在
 * 内存里解析出一个 `SkillRuntimePageLike`，`loadPage` 与 `read` 回退到这里即可，
 * 不需要任何 DB 记录。
 *
 * 边界
 * ----
 * 只收编**平台自带**的 skill。用户自建 skill 仍然是 DB page 记录——那是用户
 * 数据，不是系统层真相。
 */

import type { SkillDocConfig } from "./skillDocProtocol";
import { CAPABILITY_PACKS } from "../tools/toolPacks";
import type { SkillRuntimePageLike } from "./referenceRuntime";
import {
  CODING_SKILL_SLUGS,
  buildCodingSkillConfig,
  buildCodingSkillContentBySlug,
  buildCodingSkillId,
  buildCodingSkillPageKey,
} from "./codingSkills";
import {
  SPECIALIST_SKILL_SLUGS,
  buildSpecialistSkillConfig,
  buildSpecialistSkillContentBySlug,
  buildSpecialistSkillId,
  buildSpecialistSkillPageKey,
} from "./specialistSkills";
import {
  BUILTIN_OBJECT_SKILL_IDS,
  buildBuiltinObjectSkillConfig,
  buildBuiltinObjectSkillDbKey,
  buildBuiltinObjectSkillPageContent,
  type BuiltinObjectSkillKind,
} from "./builtinObjectSkills";
import {
  CODE_PLANNER_SKILL_SLUGS,
  buildCodePlannerSkillConfig,
  buildCodePlannerSkillId,
  buildCodePlannerSkillPageKey,
  buildCodePlannerSkillPageRecords,
} from "./codePlannerSkills";
import {
  SEARCH_DIALOG_SKILL_SLUGS,
  buildSearchDialogSkillConfig,
  buildSearchDialogSkillContentBySlug,
  buildSearchDialogSkillId,
  buildSearchDialogSkillPageKey,
} from "./searchDialogSkill";
import {
  SEARCH_SPACE_SKILL_SLUGS,
  buildSearchSpaceSkillConfig,
  buildSearchSpaceSkillContentBySlug,
  buildSearchSpaceSkillId,
  buildSearchSpaceSkillPageKey,
} from "./searchSpaceSkill";

export type BuiltinSkillEntry = {
  slug: string;
  skillId: string;
  title: string;
  config: SkillDocConfig;
  content: string;
  /**
   * 该 skill 在 DB 里「本该」占用的页面 key。注册表自己不落库，这个函数只用于
   * 与既有 `extraReferences`（历史上写过真实 page key）保持身份兼容。
   */
  buildPageKey: (userId: string) => string;
};

type BuiltinSkillSource = {
  slugs: readonly string[];
  buildSkillId: (slug: any) => string;
  buildPageKey: (userId: string, slug: any) => string;
  buildConfig: (slug: any) => SkillDocConfig;
  buildContent: (slug: any) => string;
};

/**
 * codePlanner 没有 `buildXSkillContentBySlug`，它的正文在 page records 里。
 * 这里就地取出，避免为了统一形状去改动 P5 才会重写的那个模块。
 */
const codePlannerContentBySlug = (() => {
  const cache = new Map<string, string>();
  return (slug: string): string => {
    if (cache.size === 0) {
      // userId 只影响 requiredSkills 里引用的 page key，正文本身与用户无关；
      // 注册表按 slug 解析，所以用一个稳定的占位 owner 即可。
      for (const page of buildCodePlannerSkillPageRecords("platform-skill-owner")) {
        cache.set(page.slug, page.content);
      }
    }
    return cache.get(slug) ?? "";
  };
})();

/**
 * object skill 用 kind 当 slug、用固定字符串当 skillId（`builtin-table-skill-v1`），
 * 与另外三源的 FNV id 不同源但同样确定，能共用同一套后缀匹配。
 * 它们是「指派型」skill——object 助手的 agent.references 直接指向其页面 key，
 * 所以必须进注册表，否则那条指派链路仍然依赖 DB 里有物化副本。
 */
const OBJECT_SKILL_KINDS = Object.keys(
  BUILTIN_OBJECT_SKILL_IDS,
) as BuiltinObjectSkillKind[];

const SOURCES: BuiltinSkillSource[] = [
  {
    slugs: OBJECT_SKILL_KINDS,
    buildSkillId: (kind: BuiltinObjectSkillKind) => BUILTIN_OBJECT_SKILL_IDS[kind],
    buildPageKey: (userId: string, kind: BuiltinObjectSkillKind) =>
      buildBuiltinObjectSkillDbKey(kind, userId),
    buildConfig: buildBuiltinObjectSkillConfig,
    buildContent: buildBuiltinObjectSkillPageContent,
  },
  {
    slugs: CODING_SKILL_SLUGS,
    buildSkillId: buildCodingSkillId,
    buildPageKey: buildCodingSkillPageKey,
    buildConfig: buildCodingSkillConfig,
    buildContent: buildCodingSkillContentBySlug,
  },
  {
    slugs: SPECIALIST_SKILL_SLUGS,
    buildSkillId: buildSpecialistSkillId,
    buildPageKey: buildSpecialistSkillPageKey,
    buildConfig: buildSpecialistSkillConfig,
    buildContent: buildSpecialistSkillContentBySlug,
  },
  {
    slugs: CODE_PLANNER_SKILL_SLUGS,
    buildSkillId: buildCodePlannerSkillId,
    buildPageKey: buildCodePlannerSkillPageKey,
    buildConfig: buildCodePlannerSkillConfig,
    buildContent: codePlannerContentBySlug,
  },
  {
    slugs: SEARCH_DIALOG_SKILL_SLUGS,
    buildSkillId: buildSearchDialogSkillId,
    buildPageKey: buildSearchDialogSkillPageKey,
    buildConfig: buildSearchDialogSkillConfig,
    buildContent: buildSearchDialogSkillContentBySlug,
  },
  {
    slugs: SEARCH_SPACE_SKILL_SLUGS,
    buildSkillId: buildSearchSpaceSkillId,
    buildPageKey: buildSearchSpaceSkillPageKey,
    buildConfig: buildSearchSpaceSkillConfig,
    buildContent: buildSearchSpaceSkillContentBySlug,
  },
];

const buildRegistry = (): BuiltinSkillEntry[] => {
  const entries: BuiltinSkillEntry[] = [];
  const seenSlugs = new Set<string>();
  for (const source of SOURCES) {
    for (const slug of source.slugs) {
      if (seenSlugs.has(slug)) {
        throw new Error(`Duplicate builtin skill slug across sources: ${slug}`);
      }
      seenSlugs.add(slug);
      const config = source.buildConfig(slug);
      entries.push({
        slug,
        skillId: source.buildSkillId(slug),
        title: config.name || slug,
        config,
        content: source.buildContent(slug),
        buildPageKey: (userId: string) => source.buildPageKey(userId, slug),
      });
    }
  }
  return entries;
};

const REGISTRY: readonly BuiltinSkillEntry[] = buildRegistry();

const BY_SLUG = new Map(REGISTRY.map((entry) => [entry.slug, entry]));
const BY_SKILL_ID = new Map(REGISTRY.map((entry) => [entry.skillId, entry]));
const BY_LOWER_NAME = new Map(
  REGISTRY.map((entry) => [entry.title.trim().toLowerCase(), entry]),
);

export const listBuiltinSkills = (): readonly BuiltinSkillEntry[] => REGISTRY;

/**
 * 按 **dbKey 身份** 解析注册表条目——只认能唯一证明「这就是某个内置 skill」
 * 的三种写法：
 *   - slug（`coding`）
 *   - skillId（`01SK...` / `builtin-table-skill-v1`）
 *   - 任意 userId 的页面 key（`page-<userId>-<skillId>`）——历史
 *     `extraReferences` / `agent.references` 里存的就是这种，必须认出来
 *
 * **刻意不认 skill 名称**：这个函数用在引用解析的读取路径上，会抢在 `read()`
 * 之前返回。按名称匹配会让「用户自建的、恰好同名的 skill」被内置版本遮蔽。
 * 按名字找请用 `resolveBuiltinSkillByName`（只用于 loadSkill 的兜底，且在
 * space 索引查不到之后才轮到它）。
 *
 * 页面 key 必须带 `page-` 前缀才算数：只用后缀匹配的话，
 * `agent-<userId>-<skillId>` 这类别的实体键也会被误判成内置 skill。
 */
export const resolveBuiltinSkillEntry = (
  identifier: string | null | undefined,
): BuiltinSkillEntry | null => {
  const raw = typeof identifier === "string" ? identifier.trim() : "";
  if (!raw) return null;

  const bySlug = BY_SLUG.get(raw);
  if (bySlug) return bySlug;

  const byId = BY_SKILL_ID.get(raw);
  if (byId) return byId;

  if (raw.startsWith("page-")) {
    for (const entry of REGISTRY) {
      if (raw.endsWith(`-${entry.skillId}`)) return entry;
    }
  }

  return null;
};

/**
 * 按名称/slug/skillId 解析——**只给 loadSkill 的内置兜底用**。
 * 调用方必须先查过用户自己的 skill 索引（`loadSkillTool` 就是 `if (!matched)`
 * 才走到这里），否则同名的用户 skill 会被内置版本抢走。
 */
export const resolveBuiltinSkillByName = (
  identifier: string | null | undefined,
): BuiltinSkillEntry | null => {
  const raw = typeof identifier === "string" ? identifier.trim() : "";
  if (!raw) return null;
  return (
    resolveBuiltinSkillEntry(raw) ?? BY_LOWER_NAME.get(raw.toLowerCase()) ?? null
  );
};

export const resolveBuiltinSkillSlug = (
  identifier: string | null | undefined,
): string | null => resolveBuiltinSkillEntry(identifier)?.slug ?? null;

/**
 * 解析成 skill 图/引用解析可直接消费的页面对象——**不查库**。
 *
 * `dbKey` 回填请求方用的那个标识，让 `resolveSkillGraphFromRoots` 的 visited
 * 去重与调用方的 contentByKey 命中同一个键。
 */
export const resolveBuiltinSkillPage = (
  identifier: string | null | undefined,
): SkillRuntimePageLike | null => {
  const entry = resolveBuiltinSkillEntry(identifier);
  if (!entry) return null;
  const raw = typeof identifier === "string" ? identifier.trim() : entry.slug;
  return {
    dbKey: raw || entry.slug,
    title: entry.title,
    content: entry.content,
    meta: { kind: "skill", skillConfig: entry.config },
    ...(entry.config.toolNames?.length ? { tools: [...entry.config.toolNames] } : {}),
  };
};


/* ──────────────────────────────────────────────────────────────────────────
 * 能力包视图（P2）
 *
 * 能力包与内置 skill 表达的是同一类东西——「一组工具 + 一段用法纪律」——只是
 * 一个按布尔 `enabledPacks` 消费、一个按 `triggerMode` 三态消费。P3 要把两者
 * 统一到 `agent.skills: Record<slug, triggerMode>`，那之前先让注册表能同时
 * 供应两边，调用方不用 import 两个模块。
 *
 * **本节零行为变更**：只是把 `CAPABILITY_PACKS` 换个形状读出来，
 * `expandEnabledPacks` / `applySystemBuiltinSkillFilter` 一行没改。
 *
 * 命名空间是分开的（见下方 CAPABILITY_SLUG_COLLISIONS）：`code` 与
 * `app-builder` 在两边都存在且**指的是同一个能力的两半**——能力包拿着工具，
 * skill 拿着协议。合并是 P3 的决策，不在这里替它做。
 * ────────────────────────────────────────────────────────────────────────── */

export type BuiltinCapabilityEntry = {
  kind: "capability";
  slug: string;
  title: string;
  description: string;
  toolNames: readonly string[];
  promptPatch?: string;
  icon: string;
  defaultEnabled: boolean;
};

const CAPABILITIES: readonly BuiltinCapabilityEntry[] = CAPABILITY_PACKS.map(
  (pack) => ({
    kind: "capability" as const,
    slug: pack.id,
    title: pack.label,
    description: pack.description,
    toolNames: pack.tools,
    ...(pack.promptPatch ? { promptPatch: pack.promptPatch } : {}),
    icon: pack.icon,
    defaultEnabled: pack.defaultEnabled,
  }),
);

const CAPABILITY_BY_SLUG = new Map(CAPABILITIES.map((c) => [c.slug, c]));

export const listBuiltinCapabilities = (): readonly BuiltinCapabilityEntry[] =>
  CAPABILITIES;

export const resolveBuiltinCapability = (
  slug: string | null | undefined,
): BuiltinCapabilityEntry | null => {
  const raw = typeof slug === "string" ? slug.trim() : "";
  return raw ? (CAPABILITY_BY_SLUG.get(raw) ?? null) : null;
};

/**
 * 两边同名的 slug。**不是命名事故**——是同一个能力被拆成两半：
 * 能力包持有工具、skill 持有协议。`specialistSkills` 里 app-builder 的正文
 * 甚至用散文手写了这层依赖（「本 skill 的工具由 app-builder 能力包注入」），
 * 说明耦合是真实的，只是没有表达成结构。
 *
 * 曾经有两个，`code` 已解决：object skill 那半本来就叫「编码风格技能」，
 * 内容是代码质量标准（文件长度/函数长度/嵌套/不可变性），与能力包的操作纪律
 * 是**不同的东西**、不该合并；`code` 这个名字是它抢的，已改名 code-style。
 *
 * 剩下的 app-builder 是真正的「一个能力两半」，合并是 P3 的决策——它改变
 * 授权面：合并后 `loadSkill("app-builder")` 会连带拿到 app 文件工具。
 * （appDeploy 已拆去 app-deploy 独立包，所以这个授权面比拆分前小得多。）
 *
 * 这个常量存在的意义是让冲突**可见且被测试钉住**——将来有人无意间在任一侧
 * 增删同名条目，测试会红。
 */
export const CAPABILITY_SLUG_COLLISIONS = ["app-builder"] as const;
