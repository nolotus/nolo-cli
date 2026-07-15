import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

const SKILL_DOC_ENUMS = {
  triggerMode: ["explicit", "required", "recommended"],
  budgetTier: ["low", "medium", "high"],
  modality: ["text", "image", "video", "audio", "3d"],
  docKind: ["knowledge", "instruction", "skill"],
} as const;

type SkillDocEnumKey = keyof typeof SKILL_DOC_ENUMS;

export type SkillTriggerMode = (typeof SKILL_DOC_ENUMS.triggerMode)[number];
export type SkillBudgetTier = (typeof SKILL_DOC_ENUMS.budgetTier)[number];
export type SkillModality = (typeof SKILL_DOC_ENUMS.modality)[number];
export type SkillDocKind = (typeof SKILL_DOC_ENUMS.docKind)[number];

export interface SkillDocConfig {
  version: "0.1";
  kind: "skill";
  id?: string;
  name: string;
  description: string;
  triggerMode?: SkillTriggerMode;
  toolNames?: string[];
  preferredAgents?: string[];
  budgetTier?: SkillBudgetTier;
  dispatchPreferred?: boolean;
  modalities?: SkillModality[];
  requiredSkills?: string[];
  recommendedSkills?: string[];
  promptPatch?: string;
  discover?: {
    keywords?: string[];
    examples?: string[];
  };
}

export interface SkillEvalCase {
  input: string;
  expectedTools?: string[];
  expectedSignals?: string[];
  forbiddenSignals?: string[];
}

export interface SkillEvalConfig {
  version: "0.1";
  cases: SkillEvalCase[];
}

export interface WorkflowReferenceConfig {
  version: "0.1";
  kind: "workflow";
  id?: string;
  name: string;
  description: string;
  defaultAgent?: string;
  inputs?: string[];
  recommendedTools?: string[];
  requiredTools?: string[];
  requiredOutputs?: string[];
  gates?: string[];
  budgetTier?: SkillBudgetTier;
  contextStrategy?: string;
  failureProtocol?: string;
}

export interface PageSkillMetadata {
  kind?: SkillDocKind;
  requiredSkills?: string[];
  recommendedSkills?: string[];
  skillConfig?: SkillDocConfig;
  evalConfig?: SkillEvalConfig;
  workflowConfig?: WorkflowReferenceConfig;
}

export interface ParsedSkillDocProtocol {
  content: string;
  meta?: PageSkillMetadata;
}

export interface ParsedExternalSkillMarkdown {
  name?: string;
  description?: string;
  compatibility?: string;
  allowedTools: string[];
  metadata?: Record<string, string>;
  body: string;
}

const SKILL_CONFIG_BLOCK = "skill-config";
const EVAL_CONFIG_BLOCK = "eval-config";
const WORKFLOW_CONFIG_BLOCK = "workflow-config";

/**
 * Pure string-list normalizer for skill-doc YAML / builder args.
 *
 * Locality: one seam for "unknown → unique non-empty trimmed strings" so
 * protocol parse and createSkillDoc builder share the same empty/invalid
 * fallback without re-owning the helper.
 */
export const normalizeStringArray = (
  value: unknown
): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(asTrimmedNonEmptyStringArray(value))];
  return items.length > 0 ? items : undefined;
};

const normalizeBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const normalizeSkillEnumValue = <K extends SkillDocEnumKey>(
  key: K,
  value: unknown
): (typeof SKILL_DOC_ENUMS)[K][number] | undefined =>
  typeof value === "string" &&
  (SKILL_DOC_ENUMS[key] as readonly string[]).includes(value)
    ? (value as (typeof SKILL_DOC_ENUMS)[K][number])
    : undefined;

export const normalizeSkillBudgetTier = (
  value: unknown
): SkillBudgetTier | undefined => normalizeSkillEnumValue("budgetTier", value);

export const normalizeSkillModalities = (
  value: unknown
): SkillModality[] | undefined => {
  const raw = normalizeStringArray(value);
  if (!raw) return undefined;

  const filtered = raw.flatMap((item) => {
    const modality = normalizeSkillEnumValue("modality", item);
    return modality ? [modality] : [];
  });

  return filtered.length > 0 ? Array.from(new Set(filtered)) : undefined;
};

const normalizeSkillConfig = (
  value: unknown,
  fallbackTools?: string[]
): SkillDocConfig | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = asOptionalTrimmedString(record.name) ?? "";
  const description = asOptionalTrimmedString(record.description) ?? "";

  if (!name || !description) return undefined;

  const triggerMode = normalizeSkillEnumValue("triggerMode", record.triggerMode);
  const budgetTier = normalizeSkillEnumValue("budgetTier", record.budgetTier);
  const modalities = normalizeSkillModalities(record.modalities);

  const toolNames =
    normalizeStringArray(record.toolNames) ??
    normalizeStringArray(fallbackTools) ??
    undefined;

  const discover =
    record.discover && typeof record.discover === "object"
      ? {
          keywords: normalizeStringArray(
            (record.discover as Record<string, unknown>).keywords
          ),
          examples: normalizeStringArray(
            (record.discover as Record<string, unknown>).examples
          ),
        }
      : undefined;

  return {
    version: "0.1",
    kind: "skill",
    id: asOptionalTrimmedString(record.id),
    name,
    description,
    triggerMode,
    toolNames,
    preferredAgents: normalizeStringArray(record.preferredAgents),
    budgetTier,
    dispatchPreferred: normalizeBoolean(record.dispatchPreferred),
    modalities,
    requiredSkills: normalizeStringArray(record.requiredSkills),
    recommendedSkills: normalizeStringArray(record.recommendedSkills),
    promptPatch: asOptionalTrimmedString(record.promptPatch),
    discover:
      discover?.keywords || discover?.examples ? discover : undefined,
  };
};

const normalizeEvalConfig = (value: unknown): SkillEvalConfig | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.cases)) return undefined;
  const cases: SkillEvalCase[] = [];
  for (const item of record.cases) {
    if (!item || typeof item !== "object") continue;
    const testCase = item as Record<string, unknown>;
    const input = asOptionalTrimmedString(testCase.input) ?? "";
    if (!input) continue;
    cases.push({
      input,
      expectedTools: normalizeStringArray(testCase.expectedTools),
      expectedSignals: normalizeStringArray(testCase.expectedSignals),
      forbiddenSignals: normalizeStringArray(testCase.forbiddenSignals),
    });
  }

  return cases.length > 0
    ? {
        version: "0.1",
        cases,
      }
    : undefined;
};

const normalizeWorkflowConfig = (value: unknown): WorkflowReferenceConfig | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = asOptionalTrimmedString(record.name) ?? "";
  const description = asOptionalTrimmedString(record.description) ?? "";
  if (!name || !description) return undefined;
  const budgetTier = normalizeSkillEnumValue("budgetTier", record.budgetTier);
  return {
    version: "0.1",
    kind: "workflow",
    id: asOptionalTrimmedString(record.id),
    name,
    description,
    defaultAgent: asOptionalTrimmedString(record.defaultAgent),
    inputs: normalizeStringArray(record.inputs),
    recommendedTools: normalizeStringArray(record.recommendedTools),
    requiredTools: normalizeStringArray(record.requiredTools),
    requiredOutputs: normalizeStringArray(record.requiredOutputs),
    gates: normalizeStringArray(record.gates),
    budgetTier,
    contextStrategy: asOptionalTrimmedString(record.contextStrategy),
    failureProtocol: asOptionalTrimmedString(record.failureProtocol),
  };
};

const normalizePageSkillMetadata = (
  value: unknown,
  fallbackTools?: string[]
): PageSkillMetadata | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = normalizeSkillEnumValue("docKind", record.kind);

  const meta: PageSkillMetadata = {
    kind,
    requiredSkills: normalizeStringArray(record.requiredSkills),
    recommendedSkills: normalizeStringArray(record.recommendedSkills),
    skillConfig: normalizeSkillConfig(record.skillConfig, fallbackTools),
    evalConfig: normalizeEvalConfig(record.evalConfig),
    workflowConfig: normalizeWorkflowConfig(record.workflowConfig),
  };

  if (meta.skillConfig && !meta.kind) {
    meta.kind = "skill";
  }
  if (meta.workflowConfig && !meta.kind) {
    meta.kind = "instruction";
  }

  return meta.kind ||
    meta.requiredSkills ||
    meta.recommendedSkills ||
    meta.skillConfig ||
    meta.evalConfig ||
    meta.workflowConfig
    ? meta
    : undefined;
};

const extractCommentBlock = (
  markdown: string,
  blockName: string
): string | undefined => {
  if (!markdown) return undefined;
  const matcher = new RegExp(
    `<!--\\s*${blockName}\\s*\\n([\\s\\S]*?)-->`,
    "i"
  );
  const match = markdown.match(matcher);
  return typeof match?.[1] === "string" ? match[1].trim() : undefined;
};

const removeCommentBlock = (markdown: string, blockName: string): string =>
  markdown.replace(
    new RegExp(`\\n?<!--\\s*${blockName}\\s*\\n[\\s\\S]*?-->\\s*`, "gi"),
    "\n\n"
  );

const parseYamlObject = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = loadYaml(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const parseSkillDocProtocol = (
  markdown: string | undefined,
  existingMeta?: PageSkillMetadata,
  fallbackTools?: string[]
): ParsedSkillDocProtocol => {
  const source = typeof markdown === "string" ? markdown : "";
  const skillBlock = parseYamlObject(extractCommentBlock(source, SKILL_CONFIG_BLOCK));
  const evalBlock = parseYamlObject(extractCommentBlock(source, EVAL_CONFIG_BLOCK));
  const workflowBlock = parseYamlObject(extractCommentBlock(source, WORKFLOW_CONFIG_BLOCK));
  const cleanedContent = removeCommentBlock(
    removeCommentBlock(
      removeCommentBlock(source, SKILL_CONFIG_BLOCK),
      EVAL_CONFIG_BLOCK
    ),
    WORKFLOW_CONFIG_BLOCK
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const parsedMeta = normalizePageSkillMetadata(
    {
      ...(existingMeta ?? {}),
      ...(skillBlock
        ? {
            kind:
              existingMeta?.kind === "skill" || skillBlock.kind === "skill"
                ? "skill"
                : existingMeta?.kind,
            requiredSkills:
              skillBlock.requiredSkills ?? existingMeta?.requiredSkills,
            recommendedSkills:
              skillBlock.recommendedSkills ?? existingMeta?.recommendedSkills,
            skillConfig: skillBlock,
          }
        : {}),
      ...(evalBlock ? { evalConfig: evalBlock } : {}),
      ...(workflowBlock ? { workflowConfig: workflowBlock } : {}),
    },
    fallbackTools
  );

  return {
    content: cleanedContent,
    meta: parsedMeta,
  };
};

export const resolvePageSkillMetadata = (
  page: {
    content?: string | null;
    meta?: unknown;
    tools?: string[];
  } | null | undefined
): PageSkillMetadata | undefined => {
  if (!page) return undefined;
  const existingMeta = normalizePageSkillMetadata(page.meta, page.tools);
  return parseSkillDocProtocol(page.content ?? "", existingMeta, page.tools).meta;
};

const yamlBlock = (value: Record<string, unknown>): string =>
  dumpYaml(value, { lineWidth: 120, noRefs: true }).trim();

export const buildSkillConfigComment = (config: SkillDocConfig): string => {
  const payload: Record<string, unknown> = {
    version: config.version,
    kind: config.kind,
    ...(config.id ? { id: config.id } : {}),
    name: config.name,
    description: config.description,
    ...(config.triggerMode ? { triggerMode: config.triggerMode } : {}),
    ...(config.requiredSkills?.length
      ? { requiredSkills: config.requiredSkills }
      : {}),
    ...(config.recommendedSkills?.length
      ? { recommendedSkills: config.recommendedSkills }
      : {}),
    ...(config.toolNames?.length ? { toolNames: config.toolNames } : {}),
    ...(config.preferredAgents?.length
      ? { preferredAgents: config.preferredAgents }
      : {}),
    ...(config.budgetTier ? { budgetTier: config.budgetTier } : {}),
    ...(typeof config.dispatchPreferred === "boolean"
      ? { dispatchPreferred: config.dispatchPreferred }
      : {}),
    ...(config.modalities?.length ? { modalities: config.modalities } : {}),
    ...(config.discover?.keywords?.length ||
    config.discover?.examples?.length
      ? {
          discover: {
            ...(config.discover?.keywords?.length
              ? { keywords: config.discover.keywords }
              : {}),
            ...(config.discover?.examples?.length
              ? { examples: config.discover.examples }
              : {}),
          },
        }
      : {}),
    ...(config.promptPatch ? { promptPatch: config.promptPatch } : {}),
  };
  return `<!-- ${SKILL_CONFIG_BLOCK}\n${yamlBlock(payload)}\n-->`;
};

export const buildEvalConfigComment = (config: SkillEvalConfig): string =>
  `<!-- ${EVAL_CONFIG_BLOCK}\n${yamlBlock({
    version: config.version,
    cases: config.cases,
  })}\n-->`;

export const buildWorkflowConfigComment = (config: WorkflowReferenceConfig): string =>
  `<!-- ${WORKFLOW_CONFIG_BLOCK}\n${yamlBlock({
    version: config.version,
    kind: config.kind,
    ...(config.id ? { id: config.id } : {}),
    name: config.name,
    description: config.description,
    ...(config.defaultAgent ? { defaultAgent: config.defaultAgent } : {}),
    ...(config.inputs?.length ? { inputs: config.inputs } : {}),
    ...(config.recommendedTools?.length ? { recommendedTools: config.recommendedTools } : {}),
    ...(config.requiredTools?.length ? { requiredTools: config.requiredTools } : {}),
    ...(config.requiredOutputs?.length ? { requiredOutputs: config.requiredOutputs } : {}),
    ...(config.gates?.length ? { gates: config.gates } : {}),
    ...(config.budgetTier ? { budgetTier: config.budgetTier } : {}),
    ...(config.contextStrategy ? { contextStrategy: config.contextStrategy } : {}),
    ...(config.failureProtocol ? { failureProtocol: config.failureProtocol } : {}),
  })}\n-->`;

export const buildSkillDocMarkdown = (options: {
  body?: string;
  skillConfig: SkillDocConfig;
  evalConfig?: SkillEvalConfig;
  workflowConfig?: WorkflowReferenceConfig;
}): string => {
  const sections = [
    asOptionalTrimmedString(options.body) ?? "",
    buildSkillConfigComment(options.skillConfig),
    options.evalConfig ? buildEvalConfigComment(options.evalConfig) : "",
    options.workflowConfig ? buildWorkflowConfigComment(options.workflowConfig) : "",
  ].filter(Boolean);
  return sections.join("\n\n").trim();
};

const extractFrontmatter = (markdown: string): {
  frontmatter?: Record<string, unknown>;
  body: string;
} => {
  const match = markdown.match(/^\s*---\s*\n([\s\S]*?)\n\s*---\s*\n?/);
  if (!match) return { body: markdown.trim() };
  const frontmatter = parseYamlObject(match[1]);
  const body = markdown.slice(match[0].length).trim();
  return { frontmatter, body };
};

const normalizeAllowedTools = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return normalizeStringArray(value) ?? [];
  }
  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

export const parseExternalSkillMarkdown = (
  markdown: string
): ParsedExternalSkillMarkdown => {
  const { frontmatter, body } = extractFrontmatter(markdown);
  return {
    name: asOptionalTrimmedString(frontmatter?.name),
    description: asOptionalTrimmedString(frontmatter?.description),
    compatibility: asOptionalTrimmedString(frontmatter?.compatibility),
    allowedTools: normalizeAllowedTools(frontmatter?.["allowed-tools"]),
    metadata:
      frontmatter?.metadata && typeof frontmatter.metadata === "object"
        ? Object.fromEntries(
            Object.entries(frontmatter.metadata as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, String(value)])
          )
        : undefined,
    body,
  };
};
