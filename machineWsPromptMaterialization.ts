import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type EnvLike = Record<string, string | undefined>;
type RuntimePromptPage = {
  dbKey?: string;
  promptHash?: string;
  contentBytes?: number;
} | null | undefined;

const CLOUD_PROMPT_PAGE_READ_COMMAND = "bun packages/cli/index.ts doc read";

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function resolvePromptInlineMaxBytes(env: EnvLike) {
  const raw = Number(env.NOLO_CONNECTOR_PROMPT_INLINE_MAX_BYTES);
  return Number.isFinite(raw) && raw >= 1024 ? raw : 32_000;
}

// Owns prompt ref materialization for large connector prompts without changing ws dispatch behavior.
export function materializeLargeConnectorPrompt(args: {
  prompt: string;
  cwd: string;
  env: EnvLike;
  requestId: string;
  runtimePromptPage?: RuntimePromptPage;
}) {
  const promptBytes = byteLength(args.prompt);
  const promptHash = shortHash(args.prompt);
  const maxInlineBytes = resolvePromptInlineMaxBytes(args.env);
  if (promptBytes <= maxInlineBytes) {
    return {
      prompt: args.prompt,
      promptBytes,
      promptHash,
      promptRef: null as string | null,
    };
  }

  const promptDir = join(args.cwd, ".nolo", "agent-prompts");
  mkdirSync(promptDir, { recursive: true });
  const promptRef = join(promptDir, `${args.requestId}-${promptHash}.md`);
  writeFileSync(promptRef, args.prompt, "utf8");

  return {
    prompt: [
      "A large Nolo runtime prompt has been materialized outside this command argument.",
      ...(args.runtimePromptPage?.dbKey
        ? [
            "Cloud prompt page is the shared audit/context source.",
            `Cloud prompt page: ${args.runtimePromptPage.dbKey}`,
            `Read cloud page: ${CLOUD_PROMPT_PAGE_READ_COMMAND} ${JSON.stringify(args.runtimePromptPage.dbKey)}`,
            ...(args.runtimePromptPage.promptHash
              ? [`Cloud prompt sha256 prefix: ${args.runtimePromptPage.promptHash}`]
              : []),
            "",
          ]
        : []),
      "Local prompt file is the execution-machine fallback and should match the cloud page content at run start.",
      `Prompt file: ${promptRef}`,
      `Prompt bytes: ${promptBytes}`,
      `Prompt sha256 prefix: ${promptHash}`,
      "",
      "Prefer the cloud prompt page for shared context when readable; use the local prompt file as fallback.",
      "Local repository edits, diffs, test output, and commits are still authoritative for local execution facts.",
      "If neither source is readable, stop and report PROMPT_REF_UNREADABLE with both references.",
    ].join("\n"),
    promptBytes,
    promptHash,
    promptRef,
  };
}

export function readRuntimePromptPageMeta(parsed: any) {
  const page = parsed?.payload?.meta?.runtimePromptPage;
  if (!page || typeof page !== "object") return null;
  return {
    dbKey: typeof page.dbKey === "string" ? page.dbKey : undefined,
    promptHash: typeof page.promptHash === "string" ? page.promptHash : undefined,
    contentBytes: typeof page.contentBytes === "number" ? page.contentBytes : undefined,
  };
}
