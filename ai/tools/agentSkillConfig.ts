/**
 * Agent 的能力配置：从「布尔能力包」升级到「三态 skill」。
 *
 * 旧模型 `enabledPacks: string[]` 只有两档——列进去=工具常驻，没列=完全拿不到。
 * 中间那档缺失，导致一个很别扭的现状：agent 读得到某个能力的说明书（skill 正文
 * 挂在引用里），却拿不到工具（能力包没勾），于是照着手册干活时发现工具不在。
 *
 * 新模型 `skills: Record<slug, mode>` 补上中间档：
 *
 * | 产品语义 | mode | 工具 | 提示词 | loadSkill |
 * |---|---|---|---|---|
 * | 完整启用 | `required`    | 常驻挂载 | promptPatch 注入 | 可 |
 * | 启用     | `recommended` | 不挂 | 进「相关技能」一行 | 可 |
 * | 禁用     | `disabled`    | 不挂 | 不出现 | **拒绝** |
 * | （未配置）| 缺席          | 不挂 | 不出现 | 可（既有行为） |
 *
 * 旧记录 `enabledPacks: ["web-search"]` 读成 `{ "web-search": "required" }`，
 * 没列过的包保持缺席——与今天的行为逐字节一致，不需要数据迁移。
 *
 * mode 的取值刻意与 skill 标准的 `triggerMode` 对齐（`required` /
 * `recommended`），这样 agent 侧的配置和 skill 自身的声明说的是同一种话。
 * `triggerMode` 的第三个值 `explicit` 不出现在这里——它描述的是「skill 自己
 * 默认怎么被发现」，属于 skill 定义，不是某个 agent 的选择。
 */

import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
// 无环：builtinSkillRegistry 引 ai/tools/toolPacks，但不引本模块。
import {
  resolveBuiltinCapability,
  resolveBuiltinSkillEntry,
} from "../skills/builtinSkillRegistry";

export type AgentSkillMode = "required" | "recommended" | "disabled";

/**
 * slug → 档位。
 *
 * **缺席 ≠ 禁用**：缺席表示「这个 agent 从没配置过这项能力」，行为回落到旧
 * 语义（工具不常驻、但 loadSkill 仍可按名字取用——这是既有行为）。
 * 「禁用」必须是显式的 `"disabled"`，否则 loadSkill 网关分不出「用户明确关掉」
 * 和「从没配置过」，一刀切拒绝会把存量 agent 的 loadSkill 全部打死。
 */
export type AgentSkillConfig = Record<string, AgentSkillMode>;

const MODES: readonly AgentSkillMode[] = [
  "required",
  "recommended",
  "disabled",
];

const asMode = (value: unknown): AgentSkillMode | null =>
  typeof value === "string" && (MODES as readonly string[]).includes(value)
    ? (value as AgentSkillMode)
    : null;

export type AgentSkillConfigSource = {
  /** 新字段。存在即以它为准。 */
  skills?: Record<string, unknown> | null;
  /** 旧字段。仅在没有 skills 时作为来源。 */
  enabledPacks?: string[] | null;
};

/**
 * 读时兼容：新字段优先，否则从 `enabledPacks` 派生。**不做数据迁移**——
 * 存量记录永远可读，写回时才落新字段。
 *
 * 畸形值（非法 mode、非字符串 key、非对象 skills）一律丢弃而不是抛错：
 * 这是读取路径，一条脏记录不该让整个 agent 起不来。
 */
export const resolveAgentSkillConfig = (
  source: AgentSkillConfigSource | null | undefined,
): AgentSkillConfig => {
  const out: AgentSkillConfig = {};

  const skills = source?.skills;
  if (skills && typeof skills === "object" && !Array.isArray(skills)) {
    for (const [rawSlug, rawMode] of Object.entries(skills)) {
      const slug = typeof rawSlug === "string" ? rawSlug.trim() : "";
      const mode = asMode(rawMode);
      if (slug && mode) out[slug] = mode;
    }
    return out;
  }

  // 旧记录：勾选过的包 = 工具常驻 = required。没勾过的不出现 = 禁用。
  for (const slug of asTrimmedNonEmptyStringArray(source?.enabledPacks) ?? []) {
    out[slug] = "required";
  }
  return out;
};

/** 某个 slug 在这个 agent 上的档位；禁用返回 null。 */
export const resolveAgentSkillMode = (
  config: AgentSkillConfig,
  slug: string,
): AgentSkillMode | null => config[slug] ?? null;

export const listAgentSkillsByMode = (
  config: AgentSkillConfig,
  mode: AgentSkillMode,
): string[] =>
  Object.keys(config)
    .filter((slug) => config[slug] === mode)
    .sort();

/**
 * 降级成旧 `enabledPacks`，供尚未迁移的消费方与旧客户端读取。
 *
 * 只有 `required` 能表达——`recommended` 在旧模型里没有对应物，这正是新模型
 * 多出来的那一档。所以降级是**有损**的：写回旧字段时必须同时保留 `skills`，
 * 否则「启用」档会在下一次读取时退化成「禁用」。
 */
export const toLegacyEnabledPacks = (config: AgentSkillConfig): string[] =>
  listAgentSkillsByMode(config, "required");

/**
 * 写入形态：新旧字段同时落盘。
 *
 * 双写而不是直接替换，是为了让旧版客户端（只认 enabledPacks）读到同一个 agent
 * 时不至于突然失去全部能力。等所有端都读 skills 之后再单写。
 *
 * ⚠️ **必须传 previous，否则「禁用」存不下去。**
 * `skills` 是嵌套对象，而 database patch 用 deepMerge 递归合并——少写一个 key
 * 不等于删除，旧值会被原样保留。deepMerge 只认 `null` 作为删除标记，所以这里
 * 为每个「从有到无」的 slug 显式写 null。
 *
 * 不传 previous 时退化成纯覆盖，只在「整条记录 write 而非 patch」的场景安全。
 */
export const buildAgentSkillConfigPatch = (
  config: AgentSkillConfig,
  previous?: AgentSkillConfig | null,
): { skills: Record<string, AgentSkillMode | null>; enabledPacks: string[] } => {
  const skills: Record<string, AgentSkillMode | null> = { ...config };
  for (const slug of Object.keys(previous ?? {})) {
    if (!(slug in config)) skills[slug] = null;
  }
  return { skills, enabledPacks: toLegacyEnabledPacks(config) };
};

/* ──────────────────────────────────────────────────────────────────────────
 * 与内置注册表对接
 * ────────────────────────────────────────────────────────────────────────── */

export type ResolvedAgentSkillSurface = {
  /** 常驻挂载的工具（来自 required 档）。 */
  requiredTools: string[];
  /** 仅参与排序优先级的工具（来自 recommended 档，不增长工具面）。 */
  recommendedTools: string[];
  /** required 档的方法论文档，注入 system prompt。 */
  promptPatches: string[];
  /** recommended 档的名字，进「相关技能」一行让模型知道可以 loadSkill。 */
  recommendedNames: string[];
};

type SkillSurfaceLookup = (slug: string) => {
  title?: string;
  toolNames?: readonly string[];
  promptPatch?: string;
} | null;

/**
 * 把 agent 的三态配置摊平成运行时四件套。
 *
 * `lookup` 由调用方注入（通常是 builtinSkillRegistry 的能力包 + skill 两个
 * 解析器的组合），这样本模块不依赖注册表，可以被任何宿主单测。
 */
export const resolveAgentSkillSurface = (
  config: AgentSkillConfig,
  lookup: SkillSurfaceLookup,
): ResolvedAgentSkillSurface => {
  const requiredTools = new Set<string>();
  const recommendedTools = new Set<string>();
  const promptPatches: string[] = [];
  const recommendedNames: string[] = [];

  for (const slug of Object.keys(config).sort()) {
    const entry = lookup(slug);
    if (!entry) continue;
    if (config[slug] === "required") {
      for (const tool of entry.toolNames ?? []) requiredTools.add(tool);
      if (entry.promptPatch) promptPatches.push(entry.promptPatch);
    } else if (config[slug] === "recommended") {
      // 显式只认 recommended——disabled 与缺席都落空，绝不进 recommended 面。
      // 若用 else 兜底，disabled 会被误塞进 recommendedTools/recommendedNames，
      // 与文件头「禁用 | 不挂 | 不出现」语义相悖。
      for (const tool of entry.toolNames ?? []) recommendedTools.add(tool);
      if (entry.title) recommendedNames.push(entry.title);
    }
  }

  return {
    requiredTools: [...requiredTools],
    recommendedTools: [...recommendedTools],
    promptPatches,
    recommendedNames,
  };
};

/**
 * 从 agent 记录取出「完整启用」的能力 id 列表——旧 `enabledPacks` 的等价物。
 *
 * 三个宿主的 `resolveXEffectiveEnabledPacks` 都吃这个：把它们的输入从
 * `agent.enabledPacks` 换成本函数，新旧字段就都认了，而存量记录的展开结果
 * 逐字节不变（勾过的包 = required = 出现在返回值里）。
 *
 * `recommended` 档**刻意不在返回值里**——那一档的语义就是「工具不常驻」，
 * 它不该进能力包展开管道。
 *
 * **保留声明顺序**（不排序）：能力包顺序决定工具在工具面里的先后，排序会
 * 悄悄改变模型看到的工具排列。`listAgentSkillsByMode` 的排序是给展示与快照
 * 用的，这条运行时路径不能用它。
 */
export const resolveAgentRequiredPackIds = (
  source: AgentSkillConfigSource | null | undefined,
): string[] => {
  const config = resolveAgentSkillConfig(source);
  return Object.keys(config).filter((slug) => config[slug] === "required");
};

/**
 * 「启用」档（recommended）能力的展示名，用于 system prompt 的「相关技能」一行。
 *
 * 这一档的工具刻意不常驻，所以模型必须先知道能力存在、才谈得上按需 loadSkill。
 * 不给提示的话，recommended 与「禁用」在运行时没有任何区别。
 *
 * 名字解析同样由调用方注入 lookup，本模块不依赖注册表。
 */
export const resolveAgentRecommendedSkillNames = (
  source: AgentSkillConfigSource | null | undefined,
  lookup?: (slug: string) => { title?: string } | null,
): string[] => {
  const config = resolveAgentSkillConfig(source);
  const resolve = lookup ?? defaultSkillTitleLookup;
  const out: string[] = [];
  for (const slug of Object.keys(config)) {
    if (config[slug] !== "recommended") continue;
    const title = resolve(slug)?.title;
    // 解析不出名字时退回 slug——宁可给个粗糙的名字，也好过让这一档静默消失。
    out.push(title || slug);
  }
  return out;
};

/**
 * 默认名字解析：能力包优先，再查内置 skill。
 *
 * 这里用隐式顺序是安全的，因为**只取 title 用于展示**——即便撞上
 * CAPABILITY_SLUG_COLLISIONS 里的 slug，两侧描述的也是同一个能力，展示名
 * 取哪边都不会误导用户。涉及工具授权的解析绝不能这样串联（见
 * builtinSkillRegistry 的说明）。
 */
const defaultSkillTitleLookup = (slug: string): { title?: string } | null => {
  const cap = resolveBuiltinCapability(slug);
  if (cap) return { title: cap.title };
  const skill = resolveBuiltinSkillEntry(slug);
  return skill ? { title: skill.title } : null;
};


/**
 * 这个 agent 是否**明确禁用**了某项能力。
 *
 * 只认显式 `"disabled"`——缺席一律返回 false。这条区别是 loadSkill 网关成立的
 * 前提：存量 agent 大多没配过任何能力，若把缺席当禁用，它们的 loadSkill 会被
 * 全部拒绝。
 */
export const isAgentSkillDisabled = (
  source: AgentSkillConfigSource | null | undefined,
  slug: string,
): boolean => resolveAgentSkillConfig(source)[slug] === "disabled";
