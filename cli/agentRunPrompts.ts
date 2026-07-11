// Pure message construction and workflow reference resolution helpers for
// `nolo agent run`. Extracted from agentRunCommand.ts.

import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { parseSkillDocProtocol, type WorkflowReferenceConfig } from "../ai/skills/skillDocProtocol";

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

export function skillRefToCandidatePath(cwd: string, ref: string) {
  const normalized = ref.trim();
  if (!normalized) return "";
  if (normalized.endsWith(".md") || normalized.includes("/") || normalized.includes("\\")) {
    const directPath = resolve(cwd, normalized);
    if (existsSync(directPath)) return directPath;
  }
  const fileName = normalized.replace(/[^a-zA-Z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
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

export async function resolveSkillReference(
  ref: string,
  options: {
    cwd?: string;
    readDbRecord?: (dbKey: string) => Promise<any>;
  } = {}
): Promise<ResolvedSkillReference> {
  const isDbKey = /^(page|doc)-[0-9a-z]+-/i.test(ref);
  let markdown = "";
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
  }

  const parsed = parseSkillDocProtocol(markdown);
  // parsed.meta?.skillConfig contains name, promptPatch.
  const name = parsed.meta?.skillConfig?.name;
  const promptPatch = parsed.meta?.skillConfig?.promptPatch;

  return {
    ref,
    content: parsed.content,
    ...(name ? { name } : {}),
    ...(promptPatch ? { promptPatch } : {}),
  };
}

export function prependSkillReferencesPrompt(
  message: string,
  skills?: ResolvedSkillReference[]
): string {
  if (!skills || !skills.length) return message;
  const skillBlocks = skills.map((skill) => {
    const header = `## ${skill.name ?? skill.ref}`;
    const patch = skill.promptPatch ? `${skill.promptPatch}\n` : "";
    return `${header}\n${patch}${skill.content}`;
  });
  return [
    "Temporary skill references (attached for this run only):",
    ...skillBlocks,
    "",
    "User task:",
    message,
  ].join("\n");
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
