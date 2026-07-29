import {
  parseSkillDocProtocol,
  resolvePageSkillMetadata,
  type PageSkillMetadata,
} from "./skillDocProtocol";
import { canonicalizeToolNames } from "../tools/toolNameAliases";

type PageLike = {
  dbKey?: string;
  title?: string;
  content?: string | null;
  meta?: unknown;
  tools?: string[];
} | null | undefined;

export interface SkillDiagnosticInput {
  id?: string;
  title?: string;
  content?: string;
  meta?: PageSkillMetadata;
  tools?: string[];
}

export interface SkillDoctorResult {
  ok: boolean;
  skillId?: string;
  name?: string;
  canonicalToolNames: string[];
  errors: string[];
  warnings: string[];
  notes: string[];
  evalCaseCount: number;
}

export interface SkillEvalCaseResult {
  input: string;
  passed: boolean;
  expectedTools?: string[];
  missingTools?: string[];
  missingSignals?: string[];
  forbiddenSignalsFound?: string[];
}

export interface SkillEvalResult {
  ok: boolean;
  skillId?: string;
  name?: string;
  effectiveTools: string[];
  missingReferences: string[];
  cases: SkillEvalCaseResult[];
}

const hasSkillConfigBlock = (content: string): boolean =>
  /<!--\s*skill-config\b/i.test(content);

const hasEvalConfigBlock = (content: string): boolean =>
  /<!--\s*eval-config\b/i.test(content);

const buildPageLike = (input: SkillDiagnosticInput): PageLike => ({
  dbKey: input.id,
  title: input.title,
  content: input.content,
  meta: input.meta,
  tools: input.tools,
});

export const diagnoseSkillDocument = async (
  input: SkillDiagnosticInput,
  options?: {
    getAvailableToolNames?: () => Promise<string[]>;
  }
): Promise<SkillDoctorResult> => {
  const rawContent = input.content ?? "";
  const pageLike = buildPageLike(input);
  const parsed = parseSkillDocProtocol(rawContent, input.meta, input.tools);
  const meta = resolvePageSkillMetadata(pageLike);
  const skillConfig = meta?.skillConfig;
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (hasSkillConfigBlock(rawContent) && !skillConfig) {
    errors.push("检测到 skill-config 块，但内容无效或缺少必填字段。");
  }
  if (!hasSkillConfigBlock(rawContent) && !skillConfig) {
    errors.push("未检测到有效的 skill-config 协议块。");
  }

  const rawToolNames = skillConfig?.toolNames ?? [];
  const canonicalToolNames = canonicalizeToolNames(rawToolNames);
  if (rawToolNames.length > 0 && canonicalToolNames.join("|") !== rawToolNames.join("|")) {
    notes.push(`工具名已归一化为：${canonicalToolNames.join(", ")}`);
  }

  if (skillConfig && canonicalToolNames.length === 0) {
    warnings.push("当前 skill 没有绑定工具；如果它只是说明型 skill 可以保留，否则建议补齐 toolNames。");
  }

  if (skillConfig && !skillConfig.promptPatch) {
    notes.push("当前 skill 没有 promptPatch；如果需要运行时行为提示，可以补一个简短 patch。");
  }

  if (!meta?.evalConfig?.cases?.length) {
    warnings.push("当前 skill 没有 eval-config；建议至少添加 1 条评估用例。");
  }

  if (
    Array.isArray(meta?.requiredSkills) &&
    Array.isArray(meta?.recommendedSkills)
  ) {
    const overlap = meta.requiredSkills.filter((item) =>
      meta.recommendedSkills?.includes(item)
    );
    if (overlap.length > 0) {
      warnings.push(`这些 skill 同时出现在 required/recommended 中：${overlap.join(", ")}`);
    }
  }

  if (/opencli\s+twitter\s+thread\s+--tweet_id\b/i.test(rawContent)) {
    warnings.push("检测到过期参数 `--tweet_id`，请改为 `--tweet-id`。");
  }

  if (/opencli\s+twitter/i.test(rawContent) && !/OPENCLI_CDP_ENDPOINT/.test(rawContent)) {
    notes.push("如果 OpenCLI 遇到 daemon / 19825 端口冲突，可优先复用已有 Chrome CDP：OPENCLI_CDP_ENDPOINT=http://127.0.0.1:19825");
  }

  if (options?.getAvailableToolNames && canonicalToolNames.length > 0) {
    const available = new Set(await options.getAvailableToolNames());
    const unknownTools = canonicalToolNames.filter((toolName) => !available.has(toolName));
    if (unknownTools.length > 0) {
      warnings.push(`这些工具当前运行时中不存在：${unknownTools.join(", ")}`);
    }
  }

  if (parsed.content && parsed.content.length < 30) {
    notes.push("当前正文较短；如果这是流程型 skill，建议补充步骤、边界和失败处理。");
  }

  return {
    ok: errors.length === 0,
    skillId: skillConfig?.id,
    name: skillConfig?.name,
    canonicalToolNames,
    errors,
    warnings,
    notes,
    evalCaseCount: meta?.evalConfig?.cases?.length ?? 0,
  };
};

const resolveEffectiveTools = async (
  page: PageLike,
  options?: {
    loadPage?: (dbKey: string) => Promise<PageLike | undefined>;
  },
  visited?: Set<string>,
  missingReferences?: Set<string>
): Promise<string[]> => {
  const meta = resolvePageSkillMetadata(page);
  const directTools = canonicalizeToolNames(meta?.skillConfig?.toolNames ?? page?.tools ?? []);
  const aggregate = new Set<string>(directTools);
  const nextVisited = visited ?? new Set<string>();
  const nextMissing = missingReferences ?? new Set<string>();

  if (!meta?.requiredSkills?.length || !options?.loadPage) {
    return Array.from(aggregate);
  }

  for (const dbKey of meta.requiredSkills) {
    if (!dbKey || nextVisited.has(dbKey)) continue;
    nextVisited.add(dbKey);
    const linkedPage = await options.loadPage(dbKey);
    if (!linkedPage) {
      nextMissing.add(dbKey);
      continue;
    }
    const nestedTools = await resolveEffectiveTools(
      linkedPage,
      options,
      nextVisited,
      nextMissing
    );
    for (const toolName of nestedTools) {
      aggregate.add(toolName);
    }
  }

  return Array.from(aggregate);
};

export const evaluateSkillDocument = async (
  input: SkillDiagnosticInput,
  options?: {
    loadPage?: (dbKey: string) => Promise<PageLike | undefined>;
  }
): Promise<SkillEvalResult> => {
  const pageLike = buildPageLike(input);
  const meta = resolvePageSkillMetadata(pageLike);
  const skillConfig = meta?.skillConfig;
  const evalCases = meta?.evalConfig?.cases ?? [];
  const missingReferences = new Set<string>();
  const effectiveTools = await resolveEffectiveTools(
    pageLike,
    options,
    new Set<string>(),
    missingReferences
  );
  const searchableText = [
    input.content ?? "",
    skillConfig?.description ?? "",
    skillConfig?.promptPatch ?? "",
  ]
    .join("\n")
    .toLowerCase();

  const cases: SkillEvalCaseResult[] = evalCases.map((testCase) => {
    const missingTools = (testCase.expectedTools ?? []).filter(
      (toolName) => !effectiveTools.includes(toolName)
    );
    const missingSignals = (testCase.expectedSignals ?? []).filter(
      (signal) => !searchableText.includes(signal.toLowerCase())
    );
    const forbiddenSignalsFound = (testCase.forbiddenSignals ?? []).filter(
      (signal) => searchableText.includes(signal.toLowerCase())
    );
    const passed =
      missingTools.length === 0 &&
      missingSignals.length === 0 &&
      forbiddenSignalsFound.length === 0;

    return {
      input: testCase.input,
      passed,
      ...(testCase.expectedTools?.length
        ? { expectedTools: testCase.expectedTools }
        : {}),
      ...(missingTools.length ? { missingTools } : {}),
      ...(missingSignals.length ? { missingSignals } : {}),
      ...(forbiddenSignalsFound.length ? { forbiddenSignalsFound } : {}),
    };
  });

  return {
    ok: !!skillConfig && cases.every((item) => item.passed),
    skillId: skillConfig?.id,
    name: skillConfig?.name,
    effectiveTools,
    missingReferences: Array.from(missingReferences),
    cases,
  };
};
