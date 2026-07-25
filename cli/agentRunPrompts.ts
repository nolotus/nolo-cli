// Pure message construction and workflow reference resolution helpers for
// `nolo agent run`. Extracted from agentRunCommand.ts.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";

import {
  parseExternalSkillMarkdown,
  parseSkillDocProtocol,
  type WorkflowReferenceConfig,
} from "../ai/skills/skillDocProtocol";

export type ResolvedWorkflowReference = {
  ref: string;
  content: string;
  config?: Partial<WorkflowReferenceConfig>;
};

export type ResolvedSkillReference = {
  ref: string;
  content: string;
  name?: string;
  promptPatch?: string;
  /** Tools declared via SKILL.md frontmatter `allowed-tools`. Empty when absent. */
  allowedTools?: string[];
  /** Absolute path to the skill directory (for resolving relative refs in body). */
  skillDir?: string;
};

export function workflowRefToCandidatePath(cwd: string, ref: string) {
  const normalized = ref.trim();
  if (!normalized) return "";
  if (normalized.endsWith(".md") || normalized.includes("/") || normalized.includes("\\")) {
    const directPath = resolve(cwd, normalized);
    if (existsSync(directPath)) return directPath;
  }
  const fileName = normalized.replace(/[^a-zA-Z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
  return resolve(cwd, "docs", "workflows", `${fileName}.md`);
}

/**
 * Conventional skill directories scanned in priority order.
 * - `.agents/skills/` is the SKILL.md standard directory layout
 *   (`<name>/SKILL.md`), the public open standard adopted by Cursor,
 *   Claude Code, Codex, Goose, Roo Code and others.
 * - `docs/skills/` is the bun-nolo flat layout (`<name>.md`), kept as
 *   legacy fallback.
 */
const SKILL_SEARCH_DIRS = [
  ".agents/skills",
  "docs/skills",
] as const;

/**
 * Resolve a skill ref to a file path. Search order:
 * 1. Direct path (when ref contains `/`, `\`, or ends with `.md`)
 * 2. `.agents/skills/<name>/SKILL.md` (public standard)
 * 3. `docs/skills/<name>.md` (legacy flat layout, fallback)
 * Returns the first existing path, or the legacy flat path as last resort
 * (so the caller gets a meaningful "not found" message).
 */
export function skillRefToCandidatePath(cwd: string, ref: string) {
  const normalized = ref.trim();
  if (!normalized) return "";
  if (normalized.endsWith(".md") || normalized.includes("/") || normalized.includes("\\")) {
    const directPath = resolve(cwd, normalized);
    if (existsSync(directPath)) return directPath;
  }
  const fileName = normalized.replace(/[^a-zA-Z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
  for (const dir of SKILL_SEARCH_DIRS) {
    if (dir === "docs/skills") {
      // Legacy flat layout: docs/skills/<name>.md
      const flatPath = resolve(cwd, dir, `${fileName}.md`);
      if (existsSync(flatPath)) return flatPath;
    } else {
      // SKILL.md standard: <dir>/<name>/SKILL.md
      const skillMdPath = resolve(cwd, dir, fileName, "SKILL.md");
      if (existsSync(skillMdPath)) return skillMdPath;
    }
  }
  // Last resort: legacy flat path (may not exist — caller gets "not found")
  return resolve(cwd, "docs", "skills", `${fileName}.md`);
}

export async function resolveWorkflowReference(
  ref: string,
  cwd = process.cwd()
): Promise<ResolvedWorkflowReference> {
  const path = workflowRefToCandidatePath(cwd, ref);
  if (!path || !existsSync(path)) {
    throw new Error(`Workflow reference not found: ${ref}`);
  }
  const markdown = readFileSync(path, "utf8");
  const parsed = parseSkillDocProtocol(markdown);
  return {
    ref,
    content: parsed.content,
    ...(parsed.meta?.workflowConfig ? { config: parsed.meta.workflowConfig } : {}),
  };
}

/**
 * Resolve relative Markdown links (`./references/xxx.md`) inside a skill body
 * by inlining the referenced file content. Only files within the skill
 * directory are inlined — paths escaping the directory are skipped.
 */
function inlineRelativeRefs(body: string, skillDir: string): string {
  const refPattern = /\[([^\]]+)\]\((\.\/[^)]+|[^)]+\/[^)]+)\)/g;
  const normalizedSkillDir = resolve(skillDir) + sep;
  return body.replace(refPattern, (match, label, relPath) => {
    const cleaned = relPath.trim();
    if (!cleaned.startsWith("./") && !cleaned.startsWith("../")) return match;
    const absPath = resolve(skillDir, cleaned);
    // Security: only inline files inside the skill directory.
    // Use path.relative to detect escape — prefix matching is vulnerable
    // to sibling directories with shared name prefixes (e.g. /foo vs /foo-secrets).
    const relative = relativePath(normalizedSkillDir, absPath);
    if (relative.startsWith("..") || isAbsolute(relative)) return match;
    if (!existsSync(absPath) || !absPath.endsWith(".md")) return match;
    const refContent = readFileSync(absPath, "utf8");
    return `\n\n### ${label}\n\n${refContent}\n\n`;
  });
}

/**
 * List `scripts/` subdirectory entries (if present) as a hint block appended
 * to the skill body. The agent can then use `execShell` / `readFile` to access
 * them on demand — scripts are not auto-injected into the prompt.
 */
function listSkillScripts(skillDir: string): string | null {
  const scriptsDir = join(skillDir, "scripts");
  if (!existsSync(scriptsDir) || !statSync(scriptsDir).isDirectory()) return null;
  const entries = readdirSync(scriptsDir).filter((e) => !e.startsWith("."));
  if (entries.length === 0) return null;
  return [
    "",
    "--- Available scripts (use execShell/readFile to access) ---",
    ...entries.map((e) => `- scripts/${e}`),
  ].join("\n");
}

export async function resolveSkillReference(
  ref: string,
  options: {
    cwd?: string;
    readDbRecord?: (dbKey: string) => Promise<any>;
  } = {}
): Promise<ResolvedSkillReference> {
  const isDbKey = /^(page|doc)-[0-9a-z]+-/i.test(ref);
  let markdown = "";
  let skillDir: string | undefined;
  let filePath: string | undefined;
  if (isDbKey) {
    if (!options.readDbRecord) {
      throw new Error("skill dbKey requires server access");
    }
    const record = await options.readDbRecord(ref);
    const contentText = record?.content ?? record?.prompt ?? record?.text;
    if (contentText === undefined || contentText === null || contentText === "") {
      throw new Error(`Skill reference has no content: ${ref}`);
    }
    markdown = String(contentText);
  } else {
    const cwd = options.cwd ?? process.cwd();
    const path = skillRefToCandidatePath(cwd, ref);
    if (!path || !existsSync(path)) {
      throw new Error(`Skill reference not found: ${ref}`);
    }
    markdown = readFileSync(path, "utf8");
    filePath = path;
    skillDir = dirname(path);
  }

  // Parse with bun-nolo's skill-config protocol (handles both nolo-native
  // skill-config comment blocks and standard SKILL.md frontmatter).
  const parsed = parseSkillDocProtocol(markdown);
  const name = parsed.meta?.skillConfig?.name;
  const promptPatch = parsed.meta?.skillConfig?.promptPatch;

  // Also parse standard SKILL.md frontmatter for allowed-tools (P3).
  // parseExternalSkillMarkdown extracts the `allowed-tools` field that
  // parseSkillDocProtocol does not surface.
  const externalParsed = parseExternalSkillMarkdown(markdown);
  const allowedTools = externalParsed.allowedTools;
  // Use frontmatter name as fallback when skill-config name is absent
  const effectiveName = name ?? externalParsed.name;

  // P1: inline relative path references and list scripts for directory skills
  let effectiveContent = parsed.content;
  if (skillDir) {
    effectiveContent = inlineRelativeRefs(effectiveContent, skillDir);
    const scriptsHint = listSkillScripts(skillDir);
    if (scriptsHint) effectiveContent += scriptsHint;
  }

  return {
    ref,
    content: effectiveContent,
    ...(effectiveName ? { name: effectiveName } : {}),
    ...(promptPatch ? { promptPatch } : {}),
    ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(skillDir ? { skillDir } : {}),
  };
}


/**
 * Build skill content blocks for injection as system context blocks
 * (instead of prepending to the user message). Each block is a self-contained
 * section with the skill's header, prompt patch, and body.
 *
 * Cache-friendly: placing these in the system message (via extraContextBlocks)
 * preserves LLM prefix-cache on the system+history prefix across turns,
 * whereas prepending to the user message would invalidate the cache every turn.
 */
export function buildSkillContextBlocks(
  skills?: ResolvedSkillReference[]
): string[] {
  if (!skills || !skills.length) return [];
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const skill of skills) {
    const dedupKey = skill.name ?? skill.ref;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const header = `## ${dedupKey}`;
    const patch = skill.promptPatch ? `${skill.promptPatch}\n` : "";
    blocks.push(`${header}\n${patch}${skill.content}`);
  }
  return blocks;
}

export function prependWorkflowReferencePrompt(
  message: string,
  workflow?: ResolvedWorkflowReference
): string {
  if (!workflow) return message;
  const config = workflow.config;
  return [
    "AI-native workflow reference:",
    "- This reference is guidance for the agent, not a central workflow engine.",
    `- ref: ${workflow.ref}`,
    ...(config?.id ? [`- id: ${config.id}`] : []),
    ...(config?.name ? [`- name: ${config.name}`] : []),
    ...(config?.defaultAgent ? [`- suggested defaultAgent: ${config.defaultAgent}`] : []),
    ...(config?.inputs?.length ? [`- inputs: ${config.inputs.join(", ")}`] : []),
    ...(config?.recommendedTools?.length ? [`- recommendedTools: ${config.recommendedTools.join(", ")}`] : []),
    ...(config?.requiredTools?.length ? [`- requiredTools: ${config.requiredTools.join(", ")}`] : []),
    ...(config?.requiredOutputs?.length ? [`- requiredOutputs: ${config.requiredOutputs.join(", ")}`] : []),
    ...(config?.gates?.length ? [`- gates: ${config.gates.join(", ")}`] : []),
    ...(config?.contextStrategy ? [`- contextStrategy: ${config.contextStrategy}`] : []),
    ...(config?.failureProtocol ? [`- failureProtocol: ${config.failureProtocol}`] : []),
    "",
    "Reference body:",
    workflow.content,
    "",
    "User task:",
    message,
  ].join("\n");
}

export function prependFeatureWorktreeInstruction(message: string, enabled: boolean) {
  if (!enabled) return message;
  return [
    "Local execution rule:",
    "- You are running in the current git checkout with shell access.",
    "- For read-only checks, smoke tests, or answering questions, stay in the current directory.",
    "- Before developing a new feature or making non-trivial code changes, create a separate git worktree yourself with git worktree and do the edits there.",
    "- Commit and push only when the user explicitly asks or the task requires it.",
    "",
    "User task:",
    message,
  ].join("\n");
}

export function prependSubjectDialogMarker(
  message: string,
  subjectDialogKey: string | undefined
) {
  if (!subjectDialogKey) return message;
  return [
    `Subject dialog for this run: ${subjectDialogKey}`,
    "If the user asks to evaluate the referenced dialog, call readDialog with this id/key first.",
    "",
    message,
  ].join("\n");
}

export function normalizeCliImageInput(input: string) {
  if (/^(https?:|data:|file:)/i.test(input)) return input;
  const absolutePath = resolve(input);
  if (!existsSync(absolutePath)) return input;
  const base64 = readFileSync(absolutePath).toString("base64");
  return `data:${imageMimeTypeForPath(absolutePath)};base64,${base64}`;
}

function imageMimeTypeForPath(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}
