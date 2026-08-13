/**
 * Platform-owned Code Planner skill graph (seed source of truth).
 *
 * Authoring lives here: child skill tool grants + prompt patches, composed by
 * the root skill. Until every runtime expands persisted Skill pages, the Agent
 * seed/record must carry a compiled compatibility snapshot (effective tools +
 * prompt patches) derived from this graph. The root skill reference remains
 * attached for the future runtime expansion path.
 *
 * Do not hand-maintain a second giant tool/prompt list in createSpaceAgents.
 * Tests and seed scripts materialize page records in-memory / for a given userId.
 * Do not remote-write from unit tests.
 */

import type { ReferenceItem } from "../../app/types";
import {
  DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS,
} from "../../core/builtinAgents";
import {
  buildSkillDocMarkdown,
  type SkillDocConfig,
  type SkillTriggerMode,
} from "./skillDocProtocol";
import { resolveSkillGraphFromRoots, type SkillRuntimePageLike } from "./referenceRuntime";

export const CODE_PLANNER_SKILL_SLUGS = [
  "code-planning",
  "search-first",
  "workspace-code",
  "web-research-lite",
  "dispatch-executors",
] as const;

export type CodePlannerSkillSlug = (typeof CODE_PLANNER_SKILL_SLUGS)[number];

export const CODE_PLANNER_ROOT_SKILL_SLUG: CodePlannerSkillSlug = "code-planning";

type CodePlannerSkillSeedDef = {
  slug: CodePlannerSkillSlug;
  title: string;
  description: string;
  body: string;
  triggerMode?: SkillTriggerMode;
  toolNames?: readonly string[];
  requiredSkillSlugs?: readonly CodePlannerSkillSlug[];
  promptPatch?: string;
};

/** Same FNV-1a deterministic id used by scripts/helpers/skillDocHelpers.
 * Non-blocking follow-up: packages/ai cannot import scripts helpers; leave local
 * copy until a package-safe shared helper exists. */
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

export function buildCodePlannerSkillId(slug: CodePlannerSkillSlug): string {
  return deterministicId("01SK", normalizeSkillSeed(slug) || slug);
}

export function buildCodePlannerSkillPageKey(
  userId: string,
  slug: CodePlannerSkillSlug,
): string {
  return `page-${userId}-${buildCodePlannerSkillId(slug)}`;
}

export const CODE_PLANNER_ROOT_SKILL_ID = buildCodePlannerSkillId(
  CODE_PLANNER_ROOT_SKILL_SLUG,
);

/**
 * Build the dispatch-executors prompt patch from the platform public candidate
 * key list. Every exact key must appear so the model can startAgentRun without
 * listAgents/readAgent discovery.
 */
export function buildDispatchExecutorsPromptPatch(
  candidateKeys: readonly string[] = DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS,
): string {
  const keys = candidateKeys.map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error("buildDispatchExecutorsPromptPatch requires at least one candidate key");
  }

  return [
    "派发协议：",
    "- 唯一真实分派通道是 startAgentRun。禁止声称使用了本机 CLI 或 nolo agent run（除非用户当前会话本身就是 CLI）。",
    "- 默认执行候选是下列平台公开 Agent key（无固定角色、无打分），按顺序优先考虑；无需先做发现调用：",
    ...keys.map((key, index) => `  ${index + 1}. ${key}`),
    "- started ≠ completed：startAgentRun 成功返回真实 runId（同步 wait:true 则返回结果）后才能说「已启动」；异步派发成功只表示 started。",
    "- 多文件实现、大重构、新建模块应派发执行者；单点小改可直接用工作区工具完成。",
    "- 不要写死 owner 私有 agentKey。",
  ].join("\n");
}

/**
 * Authoritative skill seed graph. Future skill edits land here, then materialize
 * into page records via seed scripts and into the Agent compatibility snapshot
 * via the sync compile helpers below.
 */
export const CODE_PLANNER_SKILL_SEEDS: readonly CodePlannerSkillSeedDef[] = [
  {
    slug: "search-first",
    title: "search-first",
    description:
      "Search-first protocol for code work: repo before web; evaluate Adopt/Extend/Compose/Build.",
    body: [
      "# search-first",
      "",
      "Protocol-only skill. It does not grant tools by itself.",
      "Use workspace and web skills for actual reads/searches.",
    ].join("\n"),
    triggerMode: "required",
    promptPatch: [
      "Search-first 协议：",
      "1. 先在绑定工作区/仓库内搜索相关模块、测试、guidance、既有 helper 与模式。",
      "2. 仅当仓库内信息不足，或需要核对 API/版本/已知 issue 时，再查依赖源码、官方文档、GitHub、Web。",
      "3. 评价路径：Adopt / Extend / Compose / Build。默认优先 Adopt/Extend/Compose；Build 需说明为何不够。",
      "4. 产出可执行计划：目标、边界、关键文件、验证方式、风险；再按用户意图决定只给计划、自己小改，还是 startAgentRun 派发。",
      "5. 工具预算：简单问答尽量 ≤5 次工具调用；禁止无目标连读大量文件。",
      "6. 从未调用的渠道禁止声称已搜索/已检查。",
    ].join("\n"),
  },
  {
    slug: "workspace-code",
    title: "workspace-code",
    description:
      "Workspace read/edit/shell protocol for local bound folders and repo inspection.",
    body: [
      "# workspace-code",
      "",
      "Declares local workspace tools and the honest fallback when they are unavailable.",
    ].join("\n"),
    triggerMode: "required",
    toolNames: [
      "listFiles",
      "readFile",
      "globFiles",
      "searchFiles",
      "editFile",
      "execShell",
    ],
    promptPatch: [
      "工作区协议：",
      "- Desktop/Space 代码对话中，用户说「当前代码」「当前改动」「当前工作区」「这个项目」「仓库里」，或点名仓库组件（如「CLI 相关」）时，默认指绑定工作区；立即用工作区/shell 工具检查。代码改动 review 时先从 git status -sb、diff/stat、相关 guidance/tests 入手。不要要求用户粘贴代码/diff，除非工作区工具确实不可用、没有绑定文件夹，或访问/命令失败——先披露失败再退回粘贴。",
      "- 只读：listFiles、readFile、globFiles、searchFiles。没有成功结果时，禁止声称「已检查仓库/工作区/文件」。",
      "- editFile：小范围精确替换。edit 前先 readFile 拿 exact oldText；默认 expectedReplacements=1，匹配数不符时停并报告 blocker。没有 writeFile——需要新建文件或整文件重写时 startAgentRun 派发。",
      "- execShell：优先只读/诊断。git 状态用 shell（如 git status -sb），禁止用 readFile 挖 .git 代替。破坏性命令与未批准的 push/合并禁止。",
      "- 工作区工具不可用（非 Desktop、未绑定 boundFolder、工具失败）时必须披露，并只基于用户粘贴内容与仍可用渠道继续。",
    ].join("\n"),
  },
  {
    slug: "web-research-lite",
    title: "web-research-lite",
    description:
      "Lite web verification protocol for dependency/docs/issue lookups.",
    body: [
      "# web-research-lite",
      "",
      "Declares external search/scrape tools for verification after local search.",
    ].join("\n"),
    triggerMode: "required",
    // 刻意不声明 toolNames：联网能力是系统层能力包（web-search / web-scrape），
    // 不编码的对话同样需要，不该由 Code Planner 私藏一份。这里只留协议，工具由
    // 宿主按能力包挂载，用户在设置页的全局开关才能真正管住它们。
    promptPatch: [
      "外部检索协议：",
      "- 联网工具由平台能力包提供（联网搜索 / 深度网页抓取），用户可能已全局关闭。",
      "- 只使用本轮实际拿到的工具；工具不在手上时如实说明「联网能力未开启」，不要臆造调用。",
      "- 没有成功结果时，禁止声称「已搜索依赖/官方文档/GitHub/Web」。",
      "- 渠道失败或不可用时必须披露缺口，改用仍可用工具；不要假装已核实。",
    ].join("\n"),
  },
  {
    slug: "dispatch-executors",
    title: "dispatch-executors",
    description:
      "startAgentRun dispatch protocol for Code Planner executor candidates.",
    body: [
      "# dispatch-executors",
      "",
      "Only startAgentRun is granted. Default candidate keys are platform public agents;",
      "hard allowlisting is enforced by runtimeContext.allowedChildAgentKeys when wired.",
    ].join("\n"),
    triggerMode: "required",
    toolNames: ["startAgentRun"],
    // Keys come from core/builtinAgents — do not hard-code a separate list here.
    promptPatch: buildDispatchExecutorsPromptPatch(
      DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS,
    ),
  },
  {
    slug: "code-planning",
    title: "code-planning",
    description:
      "Root Code Planner skill: composes search-first, workspace, web, and dispatch skills.",
    body: [
      "# code-planning",
      "",
      "Composition-only root skill for Code Planner.",
      "Attach this skill on the Agent; children load via requiredSkills.",
      "Until runtimes expand skill pages, Agent seed also carries a compiled snapshot.",
    ].join("\n"),
    triggerMode: "required",
    requiredSkillSlugs: [
      "search-first",
      "workspace-code",
      "web-research-lite",
      "dispatch-executors",
    ],
  },
] as const;

function seedBySlug(slug: CodePlannerSkillSlug): CodePlannerSkillSeedDef {
  const seed = CODE_PLANNER_SKILL_SEEDS.find((item) => item.slug === slug);
  if (!seed) {
    throw new Error(`Unknown Code Planner skill slug: ${slug}`);
  }
  return seed;
}

/** Depth-first, root-first traversal of the required skill graph (deterministic). */
export function collectCodePlannerReachableSkillSlugs(
  rootSlug: CodePlannerSkillSlug = CODE_PLANNER_ROOT_SKILL_SLUG,
): CodePlannerSkillSlug[] {
  const ordered: CodePlannerSkillSlug[] = [];
  const seen = new Set<CodePlannerSkillSlug>();

  const visit = (slug: CodePlannerSkillSlug) => {
    if (seen.has(slug)) return;
    seen.add(slug);
    ordered.push(slug);
    for (const child of seedBySlug(slug).requiredSkillSlugs ?? []) {
      visit(child);
    }
  };

  visit(rootSlug);
  return ordered;
}

/**
 * Synchronously compile the effective tool grant from the in-repo skill seed graph.
 * This is the Agent-record compatibility snapshot source for Desktop declared-tools-only.
 */
export function compileCodePlannerEffectiveTools(): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const slug of collectCodePlannerReachableSkillSlugs()) {
    for (const toolName of seedBySlug(slug).toolNames ?? []) {
      if (seen.has(toolName)) continue;
      seen.add(toolName);
      tools.push(toolName);
    }
  }

  return tools;
}

/**
 * Synchronously compile effective prompt patches in graph order.
 * Dispatch patch is regenerated from candidate keys so every exact key appears.
 */
export function compileCodePlannerEffectivePromptPatches(
  candidateKeys: readonly string[] = DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS,
): string[] {
  const patches: string[] = [];

  for (const slug of collectCodePlannerReachableSkillSlugs()) {
    if (slug === "dispatch-executors") {
      patches.push(buildDispatchExecutorsPromptPatch(candidateKeys));
      continue;
    }
    const patch = seedBySlug(slug).promptPatch;
    if (patch) patches.push(patch);
  }

  return patches;
}

/** Append compiled skill prompt patches under a thin Agent base prompt. */
export function buildCodePlannerCompiledAgentPrompt(
  basePrompt: string,
  candidateKeys: readonly string[] = DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS,
): string {
  const trimmedBase = basePrompt.trim();
  const patches = compileCodePlannerEffectivePromptPatches(candidateKeys);
  if (patches.length === 0) return trimmedBase;
  return [trimmedBase, "", ...patches].join("\n").trim();
}

/** Compiled 11-tool compatibility snapshot (sync; no remote I/O). */
export const CODE_PLANNER_COMPILED_EFFECTIVE_TOOLS: readonly string[] =
  compileCodePlannerEffectiveTools();

/**
 * Joined prompt patches for mounting the code-planning skill graph onto a
 * quick-chat tier agent for a single turn (workspaceToolsHint=true). Same
 * content the dedicated Code Planner agent compiled into its prompt.
 */
export function buildCodeWorkSkillPrompt(
  candidateKeys: readonly string[] = DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS,
): string {
  return compileCodePlannerEffectivePromptPatches(candidateKeys).join("\n\n");
}

export function buildCodePlannerSkillConfig(
  slug: CodePlannerSkillSlug,
  options?: { requiredSkills?: string[] },
): SkillDocConfig {
  const seed = seedBySlug(slug);
  const requiredSkills =
    options?.requiredSkills ??
    seed.requiredSkillSlugs?.map((childSlug) => buildCodePlannerSkillId(childSlug));

  return {
    version: "0.1",
    kind: "skill",
    id: buildCodePlannerSkillId(slug),
    name: seed.title,
    description: seed.description,
    ...(seed.triggerMode ? { triggerMode: seed.triggerMode } : {}),
    ...(seed.toolNames?.length ? { toolNames: [...seed.toolNames] } : {}),
    ...(requiredSkills?.length ? { requiredSkills: [...requiredSkills] } : {}),
    ...(seed.promptPatch ? { promptPatch: seed.promptPatch } : {}),
  };
}

export type CodePlannerSkillPageRecord = {
  slug: CodePlannerSkillSlug;
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
 * Materialize skill page records for a platform owner userId.
 * requiredSkills are rewritten to page keys so runtime loadPage can resolve them.
 */
export function buildCodePlannerSkillPageRecords(
  userId: string,
): CodePlannerSkillPageRecord[] {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("buildCodePlannerSkillPageRecords requires userId");
  }

  return CODE_PLANNER_SKILL_SEEDS.map((seed) => {
    const skillId = buildCodePlannerSkillId(seed.slug);
    const dbKey = buildCodePlannerSkillPageKey(trimmedUserId, seed.slug);
    const requiredSkills = seed.requiredSkillSlugs?.map((childSlug) =>
      buildCodePlannerSkillPageKey(trimmedUserId, childSlug),
    );
    const skillConfig = buildCodePlannerSkillConfig(seed.slug, {
      requiredSkills,
    });

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

export function buildCodePlannerRootSkillReference(
  userId: string,
): ReferenceItem {
  return {
    dbKey: buildCodePlannerSkillPageKey(userId, CODE_PLANNER_ROOT_SKILL_SLUG),
    title: CODE_PLANNER_ROOT_SKILL_SLUG,
    type: "instruction",
  };
}

/**
 * Logical root reference used on Agent seed defs before userId materialization.
 * dbKey is the stable skill id; seed writers should rewrite to page keys by dbKey only.
 */
export const CODE_PLANNER_ROOT_SKILL_REFERENCE: ReferenceItem = {
  dbKey: CODE_PLANNER_ROOT_SKILL_ID,
  title: CODE_PLANNER_ROOT_SKILL_SLUG,
  type: "instruction",
};

export function buildCodePlannerSkillContentByKey(
  userId: string,
): Map<string, SkillRuntimePageLike> {
  const contentByKey = new Map<string, SkillRuntimePageLike>();
  for (const page of buildCodePlannerSkillPageRecords(userId)) {
    const runtimePage: SkillRuntimePageLike = {
      dbKey: page.dbKey,
      title: page.title,
      content: page.content,
      meta: page.meta,
      tools: page.tools,
    };
    contentByKey.set(page.dbKey, runtimePage);
    contentByKey.set(page.skillId, runtimePage);
    contentByKey.set(page.slug, runtimePage);
  }
  return contentByKey;
}

/** Resolve effective required tools from the root skill graph (no remote I/O). */
export async function resolveCodePlannerEffectiveTools(
  userId = "platform-skill-owner",
): Promise<string[]> {
  const contentByKey = buildCodePlannerSkillContentByKey(userId);
  const rootKey = buildCodePlannerSkillPageKey(userId, CODE_PLANNER_ROOT_SKILL_SLUG);
  const resolved = await resolveSkillGraphFromRoots({
    roots: [{ identifier: rootKey, mode: "required" }],
    contentByKey,
    loadPage: async (identifier) => contentByKey.get(identifier) ?? null,
  });
  return resolved.requiredTools;
}

/**
 * 系统能力包 id：Code Planner 那一轮的联网能力从这里来，而不是 skill 自带。
 *
 * 放在这里是为了让「Code Planner 需要哪些系统能力」有唯一出处；宿主
 * （desktopAgentRuntimeTurnService）展开它们后，用户在设置页关掉「联网搜索」/
 * 「深度网页抓取」就能真正把对应工具从工具面摘掉。
 */
export const CODE_PLANNER_WEB_CAPABILITY_PACK_IDS = [
  "web-search",
  "web-scrape",
] as const;
