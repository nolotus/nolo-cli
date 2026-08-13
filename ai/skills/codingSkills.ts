/**
 * Platform-owned Coding skill graph (seed source of truth).
 *
 * Authoring lives here: child skill tool grants + prompt patches, composed by
 * the root skill. The root `coding` skill is what an agent loads (via loadSkill)
 * when it decides to write code mid-conversation. Review role skills are
 * children — the agent loads the matching role skill when dispatching a review.
 *
 * Until every runtime expands persisted Skill pages, the Agent seed/record must
 * carry a compiled compatibility snapshot (effective tools + prompt patches)
 * derived from this graph. The root skill reference remains attached for the
 * future runtime expansion path.
 *
 * Do not hand-maintain a second giant tool/prompt list in createSpaceAgents.
 * Tests and seed scripts materialize page records in-memory / for a given userId.
 * Do not remote-write from unit tests.
 */

import type { ReferenceItem } from "../../app/types";
import {
  buildSkillDocMarkdown,
  type SkillDocConfig,
  type SkillTriggerMode,
} from "./skillDocProtocol";
import { resolveSkillGraphFromRoots, type SkillRuntimePageLike } from "./referenceRuntime";
import { TOOL_PACKS } from "../tools/toolPacks";
import { buildCodeWorkDiscipline } from "../tools/codeWorkDiscipline";

export const CODING_SKILL_SLUGS = [
  "coding",
  "coding-review",
  "coding-review-code-quality",
  "coding-review-architecture",
  "coding-review-security",
  "coding-review-frontend-ux",
  "coding-review-backend-data",
] as const;

export type CodingSkillSlug = (typeof CODING_SKILL_SLUGS)[number];

export const CODING_ROOT_SKILL_SLUG: CodingSkillSlug = "coding";

type CodingSkillSeedDef = {
  slug: CodingSkillSlug;
  title: string;
  description: string;
  body: string;
  triggerMode?: SkillTriggerMode;
  toolNames?: readonly string[];
  requiredSkillSlugs?: readonly CodingSkillSlug[];
  promptPatch?: string;
};

/** Same FNV-1a deterministic id used by scripts/helpers/skillDocHelpers. */
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

export function buildCodingSkillId(slug: CodingSkillSlug): string {
  return deterministicId("01SK", normalizeSkillSeed(slug) || slug);
}

export function buildCodingSkillPageKey(
  userId: string,
  slug: CodingSkillSlug,
): string {
  return `page-${userId}-${buildCodingSkillId(slug)}`;
}

export const CODING_ROOT_SKILL_ID = buildCodingSkillId(CODING_ROOT_SKILL_SLUG);

/**
 * Authoritative coding skill seed graph. Future skill edits land here, then
 * materialize into page records via seed scripts and into the Agent
 * compatibility snapshot via the sync compile helpers below.
 */
export const CODING_SKILL_SEEDS: readonly CodingSkillSeedDef[] = [
  {
    slug: "coding",
    title: "coding",
    description:
      "Root coding skill: methodology, code-modification discipline, and review discipline. Load this when the conversation turns to writing code.",
    body: [
      "# coding",
      "",
      "Root coding skill. Loaded by the agent when it decides to write code.",
      "Children load via requiredSkills (review roles).",
      "Until runtimes expand skill pages, Agent seed also carries a compiled snapshot.",
    ].join("\n"),
    triggerMode: "required",
    requiredSkillSlugs: ["coding-review"],
    // 与「代码执行」能力包共用同一份本地代码工具清单，外加编排三件套
    // （派 review 用）。以前这里是手抄的 15 个名字，和能力包各存一份。
    toolNames: [
      ...TOOL_PACKS.CODE,
      "startAgentRun",
      "controlAgentRun",
      "listAgents",
    ],
    // 与「代码执行」能力包共用同一份纪律正文（唯一真相源）。
    // 两份曾逐字抄写并已漂移——能力包那版多了两句理由，这里以合并后的为准。
    promptPatch: buildCodeWorkDiscipline("写代码纪律"),
  },
  {
    slug: "coding-review",
    title: "coding-review",
    description:
      "Reviewer-side rule payload: review flow, finding quality gate, false-positive list, AI-generated-code concerns, output format, Verdict. Load this first, then load the matching role skill.",
    body: [
      "# coding-review",
      "",
      "Reviewer-side rule payload. Load this first, then load the matching role skill.",
    ].join("\n"),
    triggerMode: "required",
    requiredSkillSlugs: [
      "coding-review-code-quality",
      "coding-review-architecture",
      "coding-review-security",
      "coding-review-frontend-ux",
      "coding-review-backend-data",
    ],
    promptPatch: [
      "# Review 通用流程（完整版）",
      "",
      "**你是 reviewer。** 本文件是你这一轮的全部规则；spec 只补任务特定内容。",
      "**你不派发、不做候选选择、不改文件。** 只审 spec 给你的 diff，产出 finding 或 `Clean review`。",
      "",
      "## Review Dispatch Contract（规划者派发前读取）",
      "- reviewer 不得是产出该 diff 的同一 agent；规划者亲自实现的 diff 也必须交给另一个 reviewer。",
      "- 从 `listAgents` 选择 reviewer：先过滤不可用候选，胜任者中优先自建 agent（走用户自己的 API/OAuth，不耗平台 credits），其次用户收藏；有合适候选时尽量换模型家族。",
      "- 成本纪律：常规 review 优先低价胜任候选；顶档模型只用于大型深 review 或架构/计费/安全/数据高风险审查，选择前说明理由。用户点名 reviewer 不受限制。",
      "- 小任务≥1 非作者 reviewer；中任务≥1 且尽量换家族；大任务（架构/计费/安全/数据/发布/高并发）≥2 不同家族并行 + owner 最终确认。",
      "- 自建/收藏优先是偏好，不得覆盖任务兼容性、权限、运行时可用性或作者回避规则。",
      "",
      "## read-only 行为约束",
      "reviewer 不得修改被审文件、切分支、回滚他人改动、运行会写入工作区/远端的命令。不要整体禁用 shell/文件工具——review 需通过 `git diff`/`git status`/搜索/读取取证。允许只读 Git/shell 命令。若 reviewer 违反产生文件改动，规划者视该 review 无效并停止 run，不得自动回滚（工作树可能含他人改动）。",
      "",
      "## 派发与完成条件",
      "- 一律非持久化（ephemeral）派发，完成后不留 dialog 记录：`startAgentRun(agentKey, task, { ephemeral: true })`；宿主工具不可用时用 CLI 带 `--ephemeral`。",
      "- 规划者只把 diff/背景/检查范围/验收证据/角色写进 spec；规则由本文件提供，不要复制进 prompt。",
      "- 只有带实际检查证据的 finding 或 `Clean review` 才算完成。空响应、只说「我先检查」、timeout 都不是证据；最多重试一次，仍无结论就标记 `review incomplete` 交 owner，禁止无限换 agent。",
      "",
      "## 流程",
      "1. Gather：读 spec 给的审查命令（`git diff` 或 `git diff alpha...HEAD`），拿到 diff；无改动直接 Clean review。",
      "2. Scope：确认改动范围，只审 diff 触及的文件，弄清对应什么功能/修复。",
      "3. Context：不要只看 hunk；读周围实现、imports、调用方。",
      "4. Checklist：按角色从 CRITICAL → LOW；只报 >80% 有把握的真实问题。",
      "5. Report：产出 finding 表 + Verdict；同类问题合并。",
      "",
      "额外过滤：跳过纯风格偏好（除非违反项目约定）；未改动的旧代码除非 CRITICAL 安全否则不报；优先报会导致 bug/安全漏洞/数据丢失的问题。",
      "",
      "## Finding 质量门（硬规则，每条 finding 报出前过四问）",
      "任一答「否」或「不确定」则降级或丢弃：",
      "1. 能引用确切行号？（模糊发现不 actionable）",
      "2. 能描述具体失败模式？（命名输入、状态、坏结果；说不出触发条件 = 模式匹配）",
      "3. 能给出具体修复建议？（代码级，不是高层建议）",
      "4. 判断标尺——**这个团队的高级工程师真会在 review 里改这个吗?** 不会就跳过。",
      "",
      "## 假阳性清单（这些不报）",
      "- 「考虑加错误处理」：先查调用方/框架是否已处理。",
      "- 「缺少输入验证」：函数是内部调用且调用方已校验。",
      "- 「可能空指针」：上一行已类型收窄或有 if guard。",
      "- 「魔法数字」：HTTP 状态码、1000ms、60、24、1024 等已知常量跳过。",
      "- 「N+1 查询」：固定基数循环或已用 DataLoader/batching 不算。",
      "- 「函数太长」：穷举 switch、配置对象、测试表、生成代码不算。",
      "- 「缺少 await」：有意 fire-and-forget（日志/指标/后台队列）。",
      "- 「应该用 TypeScript」：JS-only 文件不报。",
      "- 「硬编码值」：测试 fixture、示例代码、文档片段里的硬编码是正确的。",
      "- 「安全戏」：非密码学场景的 `Math.random()` 不报。",
      "- 「Prefer const over let」：变量被重新赋值时不报。",
      "- 「Missing JSDoc」：单用途内部 helper 且名称+签名自解释的不报。",
      "- 「应加 useMemo/useCallback」：React Compiler 路径默认不报。",
      "",
      "## AI 生成代码 review 关注点（所有角色通用）",
      "1. **行为回归**：改 A 处时是否破坏了依赖 A 旧行为的 B 处？AI 不追踪全调用链，reviewer 要补查。",
      "2. **信任边界**：新代码是否假设输入来自可信源？外部输入（用户/API/DB 读出）是否验证后才用？",
      "3. **隐藏耦合**：是否新增了与现有抽象重复的能力？**是否制造了第二份真值？**",
      "4. **成本复杂度**：是否过度工程？单调用场景是否加了抽象层/retry/配置项？",
      "> 看到第二份真值就报，别当风格问题——它有实测代价：同一个判定逻辑在两个包各存一份悄悄漂移，会导致线上故障被伪装成无关现象。",
      "",
      "## 输出格式",
      "按严重度组织，每条 finding：",
      "`[CRITICAL] 标题` / `File: path/to/file.ts:42` / `Issue: 具体问题` / `Fix: 代码级修复建议`",
      "",
      "### 结尾必须带 Summary",
      "```",
      "## Review Summary",
      "| Severity | Count | Status |",
      "|----------|-------|--------|",
      "| CRITICAL | 0     | pass   |",
      "| HIGH     | 2     | warn   |",
      "| MEDIUM   | 3     | info   |",
      "| LOW      | 1     | note   |",
      "",
      "Verdict: APPROVE / WARNING / BLOCK",
      "```",
      "- APPROVE：无 CRITICAL 或 HIGH，含零 finding 干净 review；WARNING：仅 HIGH；BLOCK：有 CRITICAL。",
      "不要为了显得严格而拒绝批准。diff 干净就 APPROVE。",
    ].join("\n"),
  },
  {
    slug: "coding-review-code-quality",
    title: "coding-review-code-quality",
    description:
      "Code-quality review role: readability, maintainability, composability, duplication, deletability, missing tests, dead code, in-place mutation. **Mandatory role** — always dispatched, never skipped.",
    body: [
      "# coding-review-code-quality",
      "",
      "Code-quality review role. Mandatory — always dispatched.",
    ].join("\n"),
    triggerMode: "required",
    promptPatch: [
      "# 代码质量检查项（必跑）",
      "",
      "### 可读性",
      "- 之后的 AI / 新人能否看懂这段代码？命名是否自解释？",
      "- 是否容易搜索（函数/变量名是否用词准确、可 grep 到）？",
      "- 控制流是否清晰，有没有绕弯的写法？",
      "",
      "### 可维护性",
      "- 假设之后要删除或改动这个功能，是否容易改？",
      "- 改动是否被硬编码/魔法值/散落的重复逻辑锁死？",
      "- 是否过度耦合，改一处要连带改多处？",
      "",
      "### 可组合性",
      "- 是否函数式、纯函数优先？副作用是否隔离？",
      "- 新功能能否复用已有函数，而不是复制粘贴再改？",
      "- 是否把可复用的逻辑内联进了单一调用点，导致无法二次使用？",
      "",
      "### 重复性",
      "- 是否有相同代码在干相同事情（DRY）？",
      "- 能否抽取为同一个函数/工具，而不是多处各写一份？",
      "- 注意：重复的**测试** fixture 不算。",
      "",
      "### 可删除性",
      "- 哪些代码不再使用（死代码、未使用 import、不可达分支、注释掉的大块）？",
      "- 哪些代码有更好的表达方式（更短、更清晰、用标准库替代手写）？",
      "",
      "### 其他",
      "- 新代码路径明显缺测试（有可测行为却无对应用例）",
      "- 原地 mutation（应 immutable 更新时）",
    ].join("\n"),
  },
  {
    slug: "coding-review-architecture",
    title: "coding-review-architecture",
    description:
      "Architecture review role: design boundaries, circular deps, maintainability, second source of truth, API compatibility, file/function size. **Dispatch separately** for mid-level+ issues.",
    body: [
      "# coding-review-architecture",
      "",
      "Architecture review role. Dispatch separately for mid-level+ issues.",
    ].join("\n"),
    triggerMode: "required",
    promptPatch: [
      "# 架构审计员检查项",
      "",
      "- 设计边界（新增耦合是否合理）",
      "- 循环依赖",
      "- 可维护性（是否过度工程、单实现抽象、无人 config）",
      "- 是否与现有抽象重复（**制造第二份真值**）",
      "- API 兼容性（签名变更是否破坏调用方）",
      "- 文件/函数体量：典型 200–400 行、单文件 >800 / 函数 >50 且可拆时再报（穷举 switch/配置表除外）",
    ].join("\n"),
  },
  {
    slug: "coding-review-security",
    title: "coding-review-security",
    description:
      "Security review role: hardcoded credentials, injection, XSS, path traversal, CSRF, auth bypass, log leakage, vulnerable deps, error-info leakage. On-demand + mandatory when diff touches security-sensitive surfaces.",
    body: [
      "# coding-review-security",
      "",
      "Security review role. On-demand + mandatory on security-sensitive diffs.",
    ].join("\n"),
    triggerMode: "required",
    promptPatch: [
      "# 安全审计员检查项",
      "",
      "- 硬编码凭证（API key/password/token/connection string in source）",
      "- SQL 注入（字符串拼接 vs 参数化查询）",
      "- XSS（未转义的用户输入渲染到 HTML/JSX）",
      "- 路径穿越（用户控制的文件路径未消毒）",
      "- CSRF（状态变更端点缺 CSRF 保护）",
      "- 认证绕过（受保护路由缺 auth 检查）",
      "- 日志泄露敏感数据（token/password/PII 出现在日志里）",
      "- 已知脆弱依赖（若 diff 升级了有公开 CVE 的包且可证实）",
      "- 错误信息把内部堆栈/密钥细节返回给客户端",
      "",
      "## 安全敏感触发（必跑）",
      "diff 触及下列任一类时，安全审计员检查项视为**必跑**（即使 spec 未点名安全角色）：",
      "- 认证 / 授权 / session / token",
      "- 用户输入进入查询、HTML、shell、文件路径",
      "- 支付 / 计费 / 配额",
      "- 密钥、凭证、`.env`、密钥存储",
      "- 文件系统读写、任意 URL fetch（SSRF 面）",
    ].join("\n"),
  },
  {
    slug: "coding-review-frontend-ux",
    title: "coding-review-frontend-ux",
    description:
      "Frontend/UX review role: React implementation (index key, setState during render, loading/error/empty, stale closure) + UX (i18n, stuck state, error handling, accessibility). On-demand when diff touches UI.",
    body: [
      "# coding-review-frontend-ux",
      "",
      "Frontend/UX review role. On-demand when diff touches UI.",
    ].join("\n"),
    triggerMode: "required",
    promptPatch: [
      "# 前端 / UX 检查项（涉及 `packages/**` UI 时）",
      "",
      "### 前端 / React",
      "- 可重排列表用 index 当 key",
      "- render 期间 setState",
      "- 缺 loading/error/empty，易 stuck",
      "- 事件处理器明显 stale closure（有证据再报）",
      "- 硬编码用户可见文案（应走 i18n）",
      "",
      "### 用户体验",
      "- i18n（硬编码用户可见字符串）",
      "- stuck state（loading/error/empty 状态是否覆盖）",
      "- error handling（用户可见错误是否友好且不泄露内部细节）",
      "- 可访问性（ARIA、键盘导航、语义 HTML）",
    ].join("\n"),
  },
  {
    slug: "coding-review-backend-data",
    title: "coding-review-backend-data",
    description:
      "Backend/data-integrity review role: request validation, unbounded scans, missing timeout, missing rate limit, CORS + idempotency, race conditions, transaction atomicity, data-loss risk, cross-boundary leakage + silent failure (empty catch, dangerous fallback, lost stack, missing rollback, log-and-forget, debug residue). On-demand when diff touches server.",
    body: [
      "# coding-review-backend-data",
      "",
      "Backend/data-integrity review role. On-demand when diff touches server.",
    ].join("\n"),
    triggerMode: "required",
    promptPatch: [
      "# 后端 / 数据完整性检查项（涉及 server/cli/handlers 时）",
      "",
      "### 后端 / API",
      "- 请求体/参数未校验即使用",
      "- 面向用户的查询无 LIMIT / 无界扫描",
      "- 外部 HTTP/DB 调用缺 timeout",
      "- 公开端点缺合理限流（若该面本应有）",
      "- CORS / 跨源策略明显过宽且在本次 diff 引入",
      "",
      "### 数据完整性",
      "- 幂等性（重复调用是否安全）",
      "- 竞态条件（TOCTOU、并发写、缺锁）",
      "- 事务原子性（部分失败是否回滚）",
      "- 数据丢失风险（删除路径、账号切换、迁移）",
      "- 跨边界泄漏（内部 ID/状态暴露到外部 API）",
      "",
      "### 静默失败",
      "- 空 catch 块（`catch {}` 或忽略异常）",
      "- 危险降级（`.catch(() => [])`、默认值掩盖真实失败）",
      "- 丢失堆栈（generic rethrow、缺 async 处理）",
      "- 缺超时（外部 HTTP/DB 调用无 timeout）",
      "- 缺回滚（事务性操作失败后不回滚）",
      "- log-and-forget（记了日志但没传播错误）",
      "- 合并前遗留的 `console.log` / 调试残留（测试/脚本除外）",
    ].join("\n"),
  },
] as const;

function seedBySlug(slug: CodingSkillSlug): CodingSkillSeedDef {
  const seed = CODING_SKILL_SEEDS.find((item) => item.slug === slug);
  if (!seed) {
    throw new Error(`Unknown Coding skill slug: ${slug}`);
  }
  return seed;
}

/** Depth-first, root-first traversal of the required skill graph (deterministic). */
export function collectCodingReachableSkillSlugs(
  rootSlug: CodingSkillSlug = CODING_ROOT_SKILL_SLUG,
): CodingSkillSlug[] {
  const ordered: CodingSkillSlug[] = [];
  const seen = new Set<CodingSkillSlug>();

  const visit = (slug: CodingSkillSlug) => {
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

/** Synchronously compile the effective tool grant from the in-repo skill seed graph. */
export function compileCodingEffectiveTools(): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const slug of collectCodingReachableSkillSlugs()) {
    for (const toolName of seedBySlug(slug).toolNames ?? []) {
      if (seen.has(toolName)) continue;
      seen.add(toolName);
      tools.push(toolName);
    }
  }

  return tools;
}

/** Synchronously compile effective prompt patches in graph order. */
export function compileCodingEffectivePromptPatches(): string[] {
  const patches: string[] = [];
  for (const slug of collectCodingReachableSkillSlugs()) {
    const patch = seedBySlug(slug).promptPatch;
    if (patch) patches.push(patch);
  }
  return patches;
}

/** Compiled compatibility snapshot (sync; no remote I/O). */
export const CODING_COMPILED_EFFECTIVE_TOOLS: readonly string[] =
  compileCodingEffectiveTools();

export function buildCodingSkillConfig(
  slug: CodingSkillSlug,
  options?: { requiredSkills?: string[] },
): SkillDocConfig {
  const seed = seedBySlug(slug);
  const requiredSkills =
    options?.requiredSkills ??
    seed.requiredSkillSlugs?.map((childSlug) => buildCodingSkillId(childSlug));

  return {
    version: "0.1",
    kind: "skill",
    id: buildCodingSkillId(slug),
    name: seed.title,
    description: seed.description,
    ...(seed.triggerMode ? { triggerMode: seed.triggerMode } : {}),
    ...(seed.toolNames?.length ? { toolNames: [...seed.toolNames] } : {}),
    ...(requiredSkills?.length ? { requiredSkills: [...requiredSkills] } : {}),
    ...(seed.promptPatch ? { promptPatch: seed.promptPatch } : {}),
  };
}

export type CodingSkillPageRecord = {
  slug: CodingSkillSlug;
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

/** Materialize skill page records for a platform owner userId. */
export function buildCodingSkillPageRecords(
  userId: string,
): CodingSkillPageRecord[] {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("buildCodingSkillPageRecords requires userId");
  }

  return CODING_SKILL_SEEDS.map((seed) => {
    const skillId = buildCodingSkillId(seed.slug);
    const dbKey = buildCodingSkillPageKey(trimmedUserId, seed.slug);
    const requiredSkills = seed.requiredSkillSlugs?.map((childSlug) =>
      buildCodingSkillPageKey(trimmedUserId, childSlug),
    );
    const skillConfig = buildCodingSkillConfig(seed.slug, {
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

export function buildCodingRootSkillReference(
  userId: string,
): ReferenceItem {
  return {
    dbKey: buildCodingSkillPageKey(userId, CODING_ROOT_SKILL_SLUG),
    title: CODING_ROOT_SKILL_SLUG,
    type: "instruction",
  };
}

/**
 * Build a single coding skill's markdown content by slug, without a userId.
 * Used by hosts that have no DB access (e.g. CLI local loadSkill) to fall back
 * to the system-built-in coding skill content when the local skill directory
 * has no matching SKILL.md. The content is identical to the seeded page body.
 */
export function buildCodingSkillContentBySlug(
  slug: CodingSkillSlug,
): string {
  const seed = seedBySlug(slug);
  const skillConfig = buildCodingSkillConfig(slug);
  return buildSkillDocMarkdown({
    body: seed.body,
    skillConfig,
  });
}

/** Logical root reference used on Agent seed defs before userId materialization. */
export const CODING_ROOT_SKILL_REFERENCE: ReferenceItem = {
  dbKey: CODING_ROOT_SKILL_ID,
  title: CODING_ROOT_SKILL_SLUG,
  type: "instruction",
};

/**
 * Resolve a request name to a system-built-in coding skill slug, or null.
 * Shared by all hosts (web / server / CLI) so the builtin fallback rule is a
 * single source of truth. Matches on the coding skill slug (coding /
 * coding-review / coding-review-*). Returns null when the name is not a
 * builtin coding skill.
 */
export function resolveCodingBuiltinSlug(
  requestedName: string,
): CodingSkillSlug | null {
  const found = CODING_SKILL_SLUGS.find((slug) => slug === requestedName);
  return found ?? null;
}

export function buildCodingSkillContentByKey(
  userId: string,
): Map<string, SkillRuntimePageLike> {
  const contentByKey = new Map<string, SkillRuntimePageLike>();
  for (const page of buildCodingSkillPageRecords(userId)) {
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
export async function resolveCodingEffectiveTools(
  userId: string,
): Promise<string[]> {
  const contentByKey = buildCodingSkillContentByKey(userId);
  const resolved = await resolveSkillGraphFromRoots({
    roots: [{ identifier: CODING_ROOT_SKILL_ID, mode: "required" }],
    contentByKey,
    loadPage: async (identifier) => contentByKey.get(identifier) ?? null,
  });
  return resolved.requiredTools;
}

