/**
 * CLI Executor - 通过命令行工具执行 AI 任务
 *
 * 设计为可扩展：当前支持 Copilot CLI、Gemini CLI、Codex CLI、Claude CLI、Antigravity CLI 与 Qoder CLI。
 *
 * 注意：
 * - CLI provider 与普通 model 路由共享 prompt / model / 最近文本上下文这些能力面
 * - 但 CLI 不暴露本仓库可编排的 tool-calls 协议，因此这里只返回文本结果
 * - 对缺少稳定增量输出协议的 CLI，流式接口允许退化为“完成后一次性回传”
 *
 * 使用方式：
 *   import { executeCli } from "../agent/cliExecutor";
  *   const result = await executeCli("copilot", prompt, { model: "claude-haiku-4.5" });
 */

import { exec, execSync, spawn } from "child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { resolveLaunchableCodexCommand } from "../../connector-experimental/codexBinary";
import { buildCliPrompt } from "./cliPrompt";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 已支持的 CLI 工具。新增时在此联合类型追加，并在 EXECUTORS 里注册实现 */
export type CliProvider = "copilot" | "gemini" | "codex" | "claude" | "agy" | "qoder" | "opencode" | "grok";

/**
 * CLI provider 图片输入。
 *
 * - `source` 是原始输入（本地路径 / data URL / http URL / file URL）
 * - `materializedPath` 是 materialize 后写入磁盘的绝对路径
 *   （本地路径保持不变，data URL 写入临时文件，file URL 转换为本地路径）
 * - HTTP/HTTPS URL 目前无法原生传给 CLI，只作为 prompt 引用保留
 */
export interface CliImageInput {
  source: string;
  materializedPath?: string;
}

export interface CliExecuteOptions {
  model?: string;
  timeout?: number;   // ms；各 CLI executor 可按任务类型设置自己的默认值
  cwd?: string;
  env?: Record<string, string | undefined>;
  yolo?: boolean;     // 允许所有工具，默认 true（后台任务常用）
  systemPrompt?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  thinkingBudget?: number;
  /** 图片输入（本地路径 / data URL / file URL）。materialize 由内部处理。 */
  imageInputs?: CliImageInput[];
}

export interface CliExecuteResult {
  text: string;       // 解析后的纯文本回复
  raw: string;        // 原始 stdout
  elapsed: number;    // 耗时 ms
  warnings?: string[];
}

/**
 * 当底层 CLI（opencode / qoder / grok 等付费订阅 CLI）报告配额/限额时抛出的专用错误。
 * 上层派发逻辑（PM 手写 fallback 或 supervisor）可以 catch 这个错误，快速切换另一个 agent 重新派发。
 */
export class CliProviderQuotaError extends Error {
  readonly provider: CliProvider;
  constructor(provider: CliProvider, message: string) {
    super(`[QUOTA_LIMITED:${provider}] ${message}`);
    this.name = "CliProviderQuotaError";
    this.provider = provider;
  }
}

/**
 * 快速检测给定 CLI provider 的输出是否表明配额/限额（rate limit / quota exceeded）。
 * 这是“快速发现是限额的”核心，用于实现 PM 选 opencode → 限额 → 立刻换另一个派发。
 *
 * 改进：优先检查 stderr，模式更具体以避免误判正常讨论 "quota" 的情况。
 */
export function detectCliProviderQuotaLimit(
  provider: CliProvider,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): { limited: boolean; message?: string } {
  const stderrText = String(stderr || "");
  const stdoutText = String(stdout || "");
  const combined = stderrText + "\n" + stdoutText;

  const isQuotaText = (text: string) => {
    const t = text.toLowerCase();
    // 严格模式：只认明确的错误/额度耗尽信号，避免业务代码中提到 quota 被误判
    const strongPatterns = [
      /quota (exceeded|reached|limit|used up|insufficient|hit)/i,
      /usage limit (reached|exceeded|hit)/i,
      /weekly usage limit/i,
      /rate.?limit (exceeded|reached|hit)/i,
      /\b429\b.*(limit|quota|rate)/i,
      /too many request/i,
      /no (more|remaining) (credit|quota|usage)/i,
      /plan limit|membership limit/i,
      /daily limit|hourly limit reached/i,
      /limit reached.*reset/i,
      /resets in .* days/i,  // from real opencode error
    ];
    for (const re of strongPatterns) {
      if (re.test(t)) return true;
    }
    return false;
  };

  // Prefer stderr for error signals
  if (isQuotaText(stderrText)) {
    return { limited: true, message: `quota/rate limit signal from ${provider} (stderr)` };
  }
  if (isQuotaText(combined)) {
    return { limited: true, message: `quota/rate limit signal from ${provider}` };
  }
  return { limited: false };
}

type CliSessionMessage = {
  role: "user" | "assistant";
  content: string;
};

const DEFAULT_AGY_TIMEOUT_MS = 600_000;
// DEFAULT_CODEX_TIMEOUT_MS removed/disabled: timeout killing code stripped to fix
// long-running local-codex reviews via `nolo agent run local-codex --local` etc.
const DEFAULT_OPENCODE_TIMEOUT_MS = 600_000;
const DEFAULT_GROK_TIMEOUT_MS = 600_000;
const BUFFERED_STREAMING_PROVIDERS = new Set<CliProvider>([
  "codex",
  "claude",
  "agy",
  "qoder",
  "opencode",
  "grok",
]);

export function isBufferedCliStreamingProvider(provider: CliProvider): boolean {
  return BUFFERED_STREAMING_PROVIDERS.has(provider);
}

export interface CliSessionHandle {
  sessionId: string;
  provider: CliProvider;
}

export interface CliSessionState extends CliSessionHandle {
  systemPrompt?: string;
  options: CliExecuteOptions;
  messages: CliSessionMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface CliSessionTurnResult extends CliExecuteResult {
  sessionId: string;
}

const cliSessions = new Map<string, CliSessionState>();

type ProxyEnv = {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
  http_proxy?: string;
  https_proxy?: string;
  all_proxy?: string;
  no_proxy?: string;
};

function readMacSystemProxyEnv(): ProxyEnv {
  if (process.platform !== "darwin") return {};

  try {
    const raw = String(execSync("scutil --proxy", { encoding: "utf8" }) || "");
    const values = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
      if (!match) continue;
      values.set(match[1], match[2].replace(/^"|"$/g, ""));
    }

    const httpEnabled = values.get("HTTPEnable") === "1";
    const httpsEnabled = values.get("HTTPSEnable") === "1";
    const httpHost = values.get("HTTPProxy")?.trim();
    const httpsHost = values.get("HTTPSProxy")?.trim();
    const httpPort = values.get("HTTPPort")?.trim();
    const httpsPort = values.get("HTTPSPort")?.trim();
    const noProxy = values.get("ExceptionsList")?.trim();

    const httpProxy = httpEnabled && httpHost && httpPort ? `http://${httpHost}:${httpPort}` : "";
    const httpsProxy = httpsEnabled && httpsHost && httpsPort ? `http://${httpsHost}:${httpsPort}` : "";
    const allProxy = httpsProxy || httpProxy;

    return {
      ...(httpProxy ? { HTTP_PROXY: httpProxy, http_proxy: httpProxy } : {}),
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy } : {}),
      ...(allProxy ? { ALL_PROXY: allProxy, all_proxy: allProxy } : {}),
      ...(noProxy ? { NO_PROXY: noProxy, no_proxy: noProxy } : {}),
    };
  } catch {
    return {};
  }
}

function normalizeProxyEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const explicitHttp = env.HTTP_PROXY?.trim() || env.http_proxy?.trim() || "";
  const explicitHttps = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || "";
  const explicitAll = env.ALL_PROXY?.trim() || env.all_proxy?.trim() || "";
  const explicitNoProxy = env.NO_PROXY?.trim() || env.no_proxy?.trim() || "";
  const fallback = explicitHttp || explicitHttps || explicitAll ? {} : readMacSystemProxyEnv();

  const httpProxy = explicitHttp || fallback.HTTP_PROXY || fallback.http_proxy || "";
  const httpsProxy = explicitHttps || fallback.HTTPS_PROXY || fallback.https_proxy || httpProxy;
  const allProxy = explicitAll || fallback.ALL_PROXY || fallback.all_proxy || httpsProxy || httpProxy;
  const noProxy = explicitNoProxy || fallback.NO_PROXY || fallback.no_proxy || "";

  return {
    ...env,
    ...(httpProxy ? { HTTP_PROXY: httpProxy, http_proxy: httpProxy } : {}),
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy } : {}),
    ...(allProxy ? { ALL_PROXY: allProxy, all_proxy: allProxy } : {}),
    ...(noProxy ? { NO_PROXY: noProxy, no_proxy: noProxy } : {}),
  };
}

function buildCliProcessEnv(extraEnv?: Record<string, string | undefined>) {
  const baseEnv = {
    ...process.env,
    ...extraEnv,
    NO_COLOR: "1",
  };

  // Enhance PATH on macOS so GUI-launched app can find brew/local tools
  if (process.platform === "darwin") {
    const defaultMacPaths = [
      `${process.env.HOME || ""}/.local/bin`,
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      `${process.env.HOME || ""}/.bun/bin`,
      `${process.env.HOME || ""}/Library/pnpm`,
      `${process.env.HOME || ""}/.npm-global/bin`,
      `${process.env.HOME || ""}/bin`,
    ];
    const existingPath = baseEnv.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
    const paths = existingPath.split(":");
    for (const p of defaultMacPaths) {
      if (p && !paths.includes(p)) {
        paths.unshift(p); // Put brew/local paths at the front
      }
    }
    baseEnv.PATH = paths.join(":");
  }

  return Object.fromEntries(
    Object.entries(normalizeProxyEnv(baseEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function getCliProviderLabel(provider: CliProvider): string {
  switch (provider) {
    case "claude":
      return "Claude CLI";
    case "codex":
      return "Codex CLI";
    case "copilot":
      return "Copilot CLI";
    case "agy":
      return "Antigravity CLI";
    case "qoder":
      return "Qoder CLI";
    case "gemini":
      return "Gemini CLI";
    case "opencode":
      return "OpenCode CLI";
    case "grok":
      return "Grok CLI";
  }
}

function supportsNativeSystemPrompt(provider: CliProvider): boolean {
  return provider === "claude";
}

function supportsModel(provider: CliProvider): boolean {
  // Codex accepts --model syntactically, but real desktop/subscription installs
  // can fail with plan-gating errors. Keep model routing out of Codex CLI.
  return provider !== "agy" && provider !== "codex";
}

function supportsReasoningEffort(provider: CliProvider): boolean {
  return (
    provider === "claude" ||
    provider === "copilot" ||
    provider === "qoder" ||
    provider === "opencode" ||
    provider === "grok"
  );
}

function shouldPassClaudeModel(options: CliExecuteOptions): boolean {
  return (options.env?.NOLO_CLAUDE_CLI_ALLOW_MODEL ?? process.env.NOLO_CLAUDE_CLI_ALLOW_MODEL) === "1";
}

// ── CLI 图片 materialize ─────────────────────────────────────────────────────

const DATA_URL_RE = /^data:image\/([\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** data URL extension (without prefix) → 完整扩展名 */
const MIME_EXT: Record<string, string> = {
  "png": ".png",
  "jpeg": ".jpg",
  "jpg": ".jpg",
  "gif": ".gif",
  "webp": ".webp",
  "svg+xml": ".svg",
  "bmp": ".bmp",
  "tiff": ".tiff",
  "avif": ".avif",
};

function inferExtFromMime(extPart: string): string {
  return MIME_EXT[extPart.toLowerCase().trim()] ?? ".bin";
}

const FILE_URL_RE = /^file:\/\/(.+)$/;

/**
 * 将单个 data URL 图片写入临时文件，返回绝对路径。
 * caller 负责在执行完后清理 tempDir。
 */
function writeDataUrlToTempImage(dataUrl: string, tempDir: string, index: number): string {
  const match = dataUrl.match(DATA_URL_RE);
  if (!match) {
    throw new Error(`Invalid data URL format for image #${index + 1}; expected data:image/<type>;base64,<data>`);
  }
  const [, mimeExt, b64] = match;
  const ext = inferExtFromMime(mimeExt);
  const filePath = join(tempDir, `image-${index + 1}${ext}`);
  writeFileSync(filePath, Buffer.from(b64, "base64"));
  return filePath;
}

/**
 * Materialize image input sources into on-disk paths where possible.
 *
 * - 本地 path / file URL → 解析为绝对路径，无需写临时文件
 * - data:image/...;base64,... → 写入 tempDir 内临时文件
 * - http(s) URL → 不做下载，保留 source 引用；materializedPath 为空
 *
 * 返回 `{ materialized, tempDir }`，caller 需在执行完成后 `rmSync(tempDir, { recursive: true, force: true })`。
 * 当没有任何 data URL 时 tempDir 不会被创建，返回 null。
 */
export function materializeCliImageInputs(
  imageInputs: CliImageInput[],
  cwd: string,
): { materialized: CliImageInput[]; tempDir: string | null } {
  let tempDir: string | null = null;
  const materialized = imageInputs.map((input, index) => {
    const src = input.source.trim();

    if (src.startsWith("http://") || src.startsWith("https://")) {
      return { ...input, materializedPath: undefined };
    }

    const fileUrlMatch = src.match(FILE_URL_RE);
    if (fileUrlMatch) {
      const localPath = fileUrlMatch[1];
      return {
        ...input,
        materializedPath: isAbsolute(localPath) ? localPath : resolve(cwd, localPath),
      };
    }

    if (src.startsWith("data:")) {
      if (!tempDir) {
        tempDir = mkdtempSync(join(tmpdir(), "nolo-cli-assets-"));
      }
      const filePath = writeDataUrlToTempImage(src, tempDir, index);
      return { ...input, materializedPath: filePath };
    }

    // 本地路径
    return {
      ...input,
      materializedPath: isAbsolute(src) ? src : resolve(cwd, src),
    };
  });

  return { materialized, tempDir };
}

/**
 * 根据 provider 构建图片降级 prompt 块。
 * Codex 使用原生 `-i` 标志，无需注入 prompt。
 * 其他 provider 使用此函数将图片路径列表注入到 prompt 前面。
 */
function buildImageReferencePromptBlock(
  provider: CliProvider,
  materialized: CliImageInput[],
): { promptSuffix: string; warning: string | null } {
  const label = getCliProviderLabel(provider);
  const localPaths = materialized
    .filter((img) => img.materializedPath)
    .map((img) => img.materializedPath!);
  const httpUrls = materialized
    .filter((img) => !img.materializedPath)
    .map((img) => img.source);

  const lines: string[] = [];
  if (localPaths.length > 0) {
    lines.push(
      `[User attached image(s) - local file references (accessible at these paths):]`,
      ...localPaths.map((p) => `  - ${p}`),
      `Please read and analyze these image files as part of the user's request.`,
    );
  }
  if (httpUrls.length > 0) {
    lines.push(
      `[User attached image(s) - remote URLs (content not available locally):]`,
      ...httpUrls.map((u) => `  - ${u}`),
      `These remote URLs could not be downloaded automatically. If you cannot access them, describe what you can infer from context.`,
    );
  }

  const warning =
    materialized.length > 0
      ? `${label} image input is passed as local file references; native image flags are not available in this wrapper.`
      : null;

  return {
    promptSuffix: lines.length > 0 ? lines.join("\n") + "\n\n" : "",
    warning,
  };
}

function collectCliCapabilityWarnings(
  provider: CliProvider,
  options: CliExecuteOptions
): string[] {
  const warnings: string[] = [];
  const label = getCliProviderLabel(provider);

  if (options.reasoningEffort !== undefined && !supportsReasoningEffort(provider)) {
    warnings.push(`${label} does not support reasoning_effort; ignored.`);
  }

  if (provider === "claude" && options.model !== undefined && !shouldPassClaudeModel(options)) {
    warnings.push(
      "Claude CLI model selection is disabled by default because current installs can reject --model; set NOLO_CLAUDE_CLI_ALLOW_MODEL=1 to pass it through."
    );
  } else if (options.model !== undefined && !supportsModel(provider)) {
    warnings.push(`${label} does not support model selection; ignored.`);
  }

  const unsupportedFields: Array<[string, unknown]> = [
    ["temperature", options.temperature],
    ["top_p", options.topP],
    ["frequency_penalty", options.frequencyPenalty],
    ["presence_penalty", options.presencePenalty],
    ["max_tokens", options.maxTokens],
    ["enableThinking", options.enableThinking ? true : undefined],
    ["thinkingBudget", options.thinkingBudget],
  ];

  for (const [field, value] of unsupportedFields) {
    if (value !== undefined) {
      warnings.push(`${label} does not support ${field}; ignored.`);
    }
  }

  return warnings;
}

function resolveCliExecution(
  provider: CliProvider,
  prompt: string,
  options: CliExecuteOptions
): { prompt: string; options: CliExecuteOptions; warnings: string[]; imageTempDir?: string } {
  const warnings = collectCliCapabilityWarnings(provider, options);

  // Handle image inputs
  const imageInputs = options.imageInputs ?? [];
  let resolvedPrompt = prompt;
  let resolvedOptions = options;
  let imageTempDir: string | undefined;

  if (imageInputs.length > 0) {
    const { materialized, tempDir } = materializeCliImageInputs(
      imageInputs,
      options.cwd ?? process.cwd(),
    );
    imageTempDir = tempDir ?? undefined;

    if (provider === "codex") {
      // Codex uses native -i flags; update options with materialized imageInputs
      resolvedOptions = {
        ...resolvedOptions,
        imageInputs: materialized,
      };
    } else {
      // Non-codex providers: inject image references into prompt
      const block = buildImageReferencePromptBlock(provider, materialized);
      if (block.promptSuffix) {
        resolvedPrompt = block.promptSuffix + resolvedPrompt;
      }
      if (block.warning) {
        warnings.push(block.warning);
      }
    }
  }

  if (supportsNativeSystemPrompt(provider) || !options.systemPrompt?.trim()) {
    return { prompt: resolvedPrompt, options: resolvedOptions, warnings, imageTempDir };
  }
  return {
    prompt: buildCliPrompt(options.systemPrompt, resolvedPrompt),
    options: {
      ...resolvedOptions,
      systemPrompt: undefined,
    },
    warnings,
    imageTempDir,
  };
}

// ── 各 provider 实现 ─────────────────────────────────────────────────────────

/**
 * Copilot CLI 执行器
 * 调用 gh copilot -- -p "..." --silent
 */
function executeCopilot(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    model,
    reasoningEffort,
    timeout = 120_000,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      "NO_COLOR=1",
      "gh copilot --",
      `-p ${JSON.stringify(prompt)}`,
      "--silent",
      "--disable-builtin-mcps",
      "--stream off",
      "--no-color",
    ];
    if (model) args.push(`--model ${model}`);
    if (reasoningEffort) args.push(`--reasoning-effort ${reasoningEffort}`);
    if (yolo) args.push("--yolo");

    const cmd = args.join(" ");
    const start = Date.now();

    exec(
      cmd,
      { timeout, cwd, env: buildCliProcessEnv(options.env) },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed && (error as any).signal === "SIGTERM") {
            return reject(new Error(`Copilot CLI timed out after ${timeout}ms`));
          }
          return reject(
            new Error(`Copilot CLI failed: ${error.message}\nstderr: ${stderr}`)
          );
        }

        const text = stdout
          .split("\n")
          .filter((l) => !l.includes("A new release of gh is available"))
          .filter((l) => !l.includes("To upgrade, run:"))
          .filter((l) => !l.includes("https://github.com/cli/cli/releases"))
          .join("\n")
          .trim();

        resolve({ text, raw: stdout, elapsed: Date.now() - start });
      }
    );
  });
}

function normalizeGeminiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && typeof (content as any).text === "string") {
    return (content as any).text;
  }
  return "";
}

function extractGeminiEventText(event: any): string {
  if (event?.type === "message" && event.role === "assistant") {
    return normalizeGeminiContent(event.content);
  }
  if (event?.type === "result" && typeof event.result === "string") {
    return event.result;
  }
  return "";
}

function parseGeminiStreamJson(stdout: string): string {
  const parts: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      const text = extractGeminiEventText(event);
      if (text) parts.push(text);
    } catch {
      // ignore malformed lines
    }
  }

  return parts.join("");
}

function executeGemini(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    model = "gemini-3-flash-preview",
    timeout = 120_000,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      "NO_COLOR=1",
      "NODE_OPTIONS='--no-deprecation'",
      "gemini",
      `-p ${JSON.stringify(prompt)}`,
      "--output-format stream-json",
      `-m ${JSON.stringify(model)}`,
    ];
    if (yolo) args.push("--yolo");
    args.push("-e none");

    const cmd = args.join(" ");
    const start = Date.now();

    exec(
      cmd,
      { timeout, cwd, env: buildCliProcessEnv(options.env) },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed && (error as any).signal === "SIGTERM") {
            return reject(new Error(`Gemini CLI timed out after ${timeout}ms`));
          }
          return reject(
            new Error(`Gemini CLI failed: ${error.message}\nstderr: ${stderr}`)
          );
        }

        resolve({
          text: parseGeminiStreamJson(stdout),
          raw: stdout,
          elapsed: Date.now() - start,
        });
      }
    );
  });
}

function executeCodex(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    cwd = process.cwd(),
    yolo = true,
  } = options;
  // timeout handling removed at this layer to prevent premature kill on long local codex reviews
  // (e.g. via `nolo agent run local-codex --local`)

  // Collect materialized image paths from imageInputs
  const imagePaths = (options.imageInputs ?? [])
    .map((img) => img.materializedPath)
    .filter((p): p is string => Boolean(p));

  return new Promise((resolve, reject) => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-exec-"));
    const outputFile = join(tempDir, "last-message.txt");
    const executable = resolveLaunchableCodexCommand(options.env);
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--output-last-message",
      outputFile,
      "--cd",
      cwd,
    ];
    if (yolo) {
      args.push("--sandbox");
      args.push("danger-full-access");
    }
    // Add image flags for Codex CLI native image support
    for (const imgPath of imagePaths) {
      args.push("-i", imgPath);
    }
    const start = Date.now();
    const proc = spawn(executable, [...args, prompt], {
      cwd,
      env: buildCliProcessEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();

    // Timeout killing removed for codex to support long reviews via nolo local-codex.
    // Runs until completion or external kill.

    proc.stdout.on("data", (data: Buffer) => {
      stdout.write(data);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
    });

    proc.on("close", (code) => {
      const stdoutText = stdout.end();
      const stderrText = stderr.end();
      if (code !== 0 && code !== null) {
        rmSync(tempDir, { recursive: true, force: true });
        const quota = detectCliProviderQuotaLimit("codex", stdoutText, stderrText, code);
        if (quota.limited) {
          reject(new CliProviderQuotaError("codex", quota.message || "Codex reported quota/limit"));
          return;
        }
        reject(new Error(`Codex CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      let text = stdoutText.trim();
      try {
        const lastMessage = readFileSync(outputFile, "utf8").trim();
        if (lastMessage) text = lastMessage;
      } catch {
        // Fall back to raw stdout when the output file is missing.
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }

      resolve({
        text,
        raw: stdoutText,
        elapsed: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      rmSync(tempDir, { recursive: true, force: true });
      reject(err);
    });
  });
}

function executeClaude(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    model,
    systemPrompt,
    reasoningEffort,
    timeout = 120_000,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = ["--add-dir", cwd, "-p", prompt];
    if (model && shouldPassClaudeModel(options)) {
      args.push("--model");
      args.push(model);
    }
    if (systemPrompt?.trim()) {
      args.push("--system-prompt");
      args.push(systemPrompt.trim());
    }
    if (reasoningEffort) {
      args.push("--effort");
      args.push(reasoningEffort);
    }
    if (yolo) {
      args.push("--permission-mode");
      args.push("bypassPermissions");
    }

    const start = Date.now();
    const proc = spawn("claude", args, {
      cwd,
      env: buildCliProcessEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Claude CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdout.write(data);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdoutText = stdout.end();
      const stderrText = stderr.end();
      if (code !== 0 && code !== null) {
        const quota = detectCliProviderQuotaLimit("claude", stdoutText, stderrText, code);
        if (quota.limited) {
          reject(new CliProviderQuotaError("claude", quota.message || "Claude reported quota/limit"));
          return;
        }
        reject(new Error(`Claude CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      resolve({
        text: stdoutText.trim(),
        raw: stdoutText,
        elapsed: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

function formatCliTimeout(timeoutMs: number) {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

function tailText(value: string, maxChars = 1200): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function createUtf8Collector() {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let ended = false;
  const finish = () => {
    if (ended) return "";
    ended = true;
    const chunk = decoder.end();
    if (chunk) text += chunk;
    return chunk;
  };
  return {
    write(data: Buffer): string {
      if (ended) return "";
      const chunk = decoder.write(data);
      text += chunk;
      return chunk;
    },
    finish,
    end(): string {
      finish();
      return text;
    },
    get text() {
      return text;
    },
  };
}

function terminateCliProcessGroup(
  proc: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
) {
  const pid = typeof proc.pid === "number" ? proc.pid : 0;
  if (pid > 0 && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the child process if the group is unavailable.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Best effort cleanup only.
  }
}

function buildAgyTimeoutError(timeout: number, stdout: string, stderr: string) {
  const parts = [
    `Antigravity CLI timed out after ${timeout}ms.`,
    "agy print mode is agentic and can keep waiting for the conversation to become fully idle; prefer shorter scoped prompts or split the task into multiple turns.",
  ];
  const stdoutTail = tailText(stdout).trim();
  const stderrTail = tailText(stderr).trim();
  if (stdoutTail) parts.push(`stdout tail:\n${stdoutTail}`);
  if (stderrTail) parts.push(`stderr tail:\n${stderrTail}`);
  return new Error(parts.join("\n"));
}

function executeAgy(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    timeout = DEFAULT_AGY_TIMEOUT_MS,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      "--add-dir",
      cwd,
      "--print",
      prompt,
      "--print-timeout",
      formatCliTimeout(timeout),
    ];
    if (yolo) {
      args.push("--dangerously-skip-permissions");
    }

    const start = Date.now();
    const proc = spawn("agy", args, {
      cwd,
      env: buildCliProcessEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateCliProcessGroup(proc, "SIGTERM");
        forceTimer = setTimeout(() => {
          terminateCliProcessGroup(proc, "SIGKILL");
        }, 3_000);
        reject(buildAgyTimeoutError(timeout, stdout.end(), stderr.end()));
      }, timeout + 1_000);
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdout.write(data);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
    });

    proc.on("close", (code) => {
      if (settled) {
        clearTimers();
        return;
      }
      settled = true;
      clearTimers();
      const stdoutText = stdout.end();
      const stderrText = stderr.end();
      if (code !== 0 && code !== null) {
        console.error("[cliExecutor] agy process exited with non-zero code:", code, "stderr:", stderrText);
        const quota = detectCliProviderQuotaLimit("agy", stdoutText, stderrText, code);
        if (quota.limited) {
          reject(new CliProviderQuotaError("agy", quota.message || "Agy reported quota/limit"));
          return;
        }
        reject(new Error(`Antigravity CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      resolve({
        text: stdoutText.trim(),
        raw: stdoutText,
        elapsed: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      console.error("[cliExecutor] agy process error event:", err);
      reject(err);
    });
  });
}

function executeQoder(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    model,
    reasoningEffort,
    timeout = 120_000,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--cwd", cwd];
    if (model) {
      args.push("--model");
      args.push(model);
    }
    if (reasoningEffort) {
      args.push("--reasoning-effort");
      args.push(reasoningEffort);
    }
    if (yolo) {
      args.push("--dangerously-skip-permissions");
    }

    const start = Date.now();
    const proc = spawn("qoder", args, {
      cwd,
      env: buildCliProcessEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timer = setTimeout(() => {
        const partial = stdout.end() + "\n" + stderr.end();
        const q = detectCliProviderQuotaLimit("qoder", "", partial, null);  // partial is stderr biased in practice
        if (q.limited) {
          proc.kill("SIGTERM");
          reject(new CliProviderQuotaError("qoder", q.message || "Qoder quota signal seen before timeout"));
          return;
        }
        proc.kill("SIGTERM");
        reject(new Error(`Qoder CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdout.write(data);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
      const currentStderr = stderr.text;
      if (detectCliProviderQuotaLimit("qoder", "", currentStderr, null).limited) {
        if (timer) clearTimeout(timer);
        proc.kill("SIGTERM");
        reject(new CliProviderQuotaError("qoder", "quota signal detected incrementally in stderr"));
        return;
      }
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdoutText = stdout.end();
      const stderrText = stderr.end();
      const quota = detectCliProviderQuotaLimit("qoder", stdoutText, stderrText, code);
      const hasRealErrorSignal = code !== 0 || /error|fail|quota|limit|429|rate limit|exceeded/i.test(stderrText);
      if (quota.limited && hasRealErrorSignal) {
        reject(new CliProviderQuotaError("qoder", quota.message || "Qoder reported quota/limit"));
        return;
      }
      if (code !== 0 && code !== null) {
        console.error("[cliExecutor] qoder process exited with non-zero code:", code, "stderr:", stderrText);
        reject(new Error(`Qoder CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      resolve({
        text: stdoutText.trim(),
        raw: stdoutText,
        elapsed: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      console.error("[cliExecutor] qoder process error event:", err);
      reject(err);
    });
  });
}

type OpenCodeJsonEvent = {
  type?: string;
  part?: {
    type?: string;
    text?: string;
  };
};

function parseOpenCodeJsonlEvents(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as OpenCodeJsonEvent;
      if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
        parts.push(event.part.text);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return parts.join("");
}

function executeOpenCode(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    model,
    reasoningEffort,
    timeout = DEFAULT_OPENCODE_TIMEOUT_MS,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--format",
      "json",
      "--dir",
      cwd,
      "--print-logs",   // surface stream errors / quota / limit messages to stderr for fast detection
    ];
    if (model) {
      args.push("--model");
      args.push(model);
    }
    if (reasoningEffort) {
      args.push("--variant");
      args.push(reasoningEffort);
    }
    if (yolo) {
      args.push("--dangerously-skip-permissions");
    }
    args.push(prompt);

    const start = Date.now();
    const proc = spawn("opencode", args, {
      cwd,
      env: buildCliProcessEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timer = setTimeout(() => {
        // For timeout we can safely finalize
        const stdoutPartial = stdout.end();
        const stderrPartial = stderr.end();
        const q = detectCliProviderQuotaLimit("opencode", stdoutPartial, stderrPartial, null);
        if (q.limited) {
          proc.kill("SIGTERM");
          reject(new CliProviderQuotaError("opencode", q.message || "OpenCode quota signal seen before timeout"));
          return;
        }
        proc.kill("SIGTERM");
        reject(new Error(`OpenCode CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdout.write(data);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
      // Incremental detection on stderr for fast quota signals (as recommended)
      // Use .text (live, non-finalizing) not .end()
      const currentStderr = stderr.text;
      if (detectCliProviderQuotaLimit("opencode", "", currentStderr, null).limited) {
        if (timer) clearTimeout(timer);
        proc.kill("SIGTERM");
        reject(new CliProviderQuotaError("opencode", "quota signal detected incrementally in stderr"));
        return;
      }
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdoutText = stdout.end();
      const stderrText = stderr.end();

      // Quota: stderr (or error-shaped) always. stdout only checked on real error exit to avoid FP from LLM text mentioning "limit".
      const quota = detectCliProviderQuotaLimit("opencode", stdoutText, stderrText, code);
      const hasRealErrorSignal = code !== 0 || /error|fail|quota|limit|429|rate limit|exceeded/i.test(stderrText);
      if (quota.limited && hasRealErrorSignal) {
        reject(new CliProviderQuotaError("opencode", quota.message || "OpenCode reported quota/limit"));
        return;
      }

      if (code !== 0 && code !== null) {
        console.error("[cliExecutor] opencode process exited with non-zero code:", code, "stderr:", stderrText);
        reject(new Error(`OpenCode CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      resolve({
        text: parseOpenCodeJsonlEvents(stdoutText).trim(),
        raw: stdoutText,
        elapsed: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      console.error("[cliExecutor] opencode process error event:", err);
      reject(err);
    });
  });
}

type GrokJsonOutput = {
  type?: string;
  text?: string;
  message?: string;
};

function parseGrokJsonOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const parsed = JSON.parse(trimmed) as GrokJsonOutput;
  if (parsed.type === "error") {
    throw new Error(typeof parsed.message === "string" ? parsed.message : "Grok CLI failed");
  }
  return typeof parsed.text === "string" ? parsed.text : "";
}

function buildGrokProcessEnv(extraEnv?: Record<string, string | undefined>) {
  return buildCliProcessEnv({
    GROK_TELEMETRY_TRACE_UPLOAD: "0",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_FEEDBACK_ENABLED: "0",
    GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
    ...extraEnv,
  });
}

function executeGrok(
  prompt: string,
  options: CliExecuteOptions
): Promise<CliExecuteResult> {
  const {
    model,
    reasoningEffort,
    timeout = DEFAULT_GROK_TIMEOUT_MS,
    cwd = process.cwd(),
    yolo = true,
  } = options;

  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--cwd", cwd, "--output-format", "json"];
    if (model) {
      args.push("-m", model);
    }
    if (reasoningEffort) {
      args.push("--effort", reasoningEffort);
    }
    if (yolo) {
      args.push("--yolo");
    }

    const start = Date.now();
    const proc = spawn("grok", args, {
      cwd,
      env: buildGrokProcessEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timer = setTimeout(() => {
        const partial = stdout.end() + "\n" + stderr.end();
        const q = detectCliProviderQuotaLimit("grok", "", partial, null);
        if (q.limited) {
          proc.kill("SIGTERM");
          reject(new CliProviderQuotaError("grok", q.message || "Grok quota signal seen before timeout"));
          return;
        }
        proc.kill("SIGTERM");
        reject(new Error(`Grok CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdout.write(data);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
      const currentStderr = stderr.text;
      if (detectCliProviderQuotaLimit("grok", "", currentStderr, null).limited) {
        if (timer) clearTimeout(timer);
        proc.kill("SIGTERM");
        reject(new CliProviderQuotaError("grok", "quota signal detected incrementally in stderr"));
        return;
      }
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdoutText = stdout.end();
      const stderrText = stderr.end();
      const quota = detectCliProviderQuotaLimit("grok", stdoutText, stderrText, code);
      const hasRealErrorSignal = code !== 0 || /error|fail|quota|limit|429|rate limit|exceeded/i.test(stderrText);
      if (quota.limited && hasRealErrorSignal) {
        reject(new CliProviderQuotaError("grok", quota.message || "Grok reported quota/limit"));
        return;
      }
      if (code !== 0 && code !== null) {
        console.error("[cliExecutor] grok process exited with non-zero code:", code, "stderr:", stderrText);
        reject(new Error(`Grok CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      try {
        resolve({
          text: parseGrokJsonOutput(stdoutText).trim(),
          raw: stdoutText,
          elapsed: Date.now() - start,
        });
      } catch (error) {
        reject(error);
      }
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      console.error("[cliExecutor] grok process error event:", err);
      reject(err);
    });
  });
}

// ── 注册表（新增 CLI 工具时在这里加） ────────────────────────────────────────

const EXECUTORS: Record<
  CliProvider,
  (prompt: string, options: CliExecuteOptions) => Promise<CliExecuteResult>
> = {
  copilot: executeCopilot,
  gemini: executeGemini,
  codex: executeCodex,
  claude: executeClaude,
  agy: executeAgy,
  qoder: executeQoder,
  opencode: executeOpenCode,
  grok: executeGrok,
};

function formatCliSessionTask(messages: CliSessionMessage[]): string {
  return messages
    .map((message, index) => {
      const speaker = message.role === "user" ? "用户" : "助手";
      return `[${index + 1}] ${speaker}\n${message.content.trim()}`;
    })
    .join("\n\n");
}

function buildCliSessionPrompt(session: CliSessionState, userInput: string): string {
  const transcript = formatCliSessionTask([
    ...session.messages,
    { role: "user", content: userInput },
  ]);

  return [
    "以下是当前对话，请基于完整上下文继续回答最后一条用户消息。",
    transcript,
  ].join("\n\n");
}

function getCliSessionOrThrow(sessionId: string): CliSessionState {
  const session = cliSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown CLI session: "${sessionId}"`);
  }
  return session;
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 执行 CLI 任务
 *
 * @param provider  CLI 工具类型（如 "copilot" | "gemini" | "codex" | "claude" | "agy" | "qoder" | "opencode"）
 * @param prompt    完整 prompt（system prompt 已由调用方拼好）
 * @param options   执行选项
 */
export async function executeCli(
  provider: CliProvider,
  prompt: string,
  options: CliExecuteOptions = {}
): Promise<CliExecuteResult> {
  const executor = EXECUTORS[provider];
  if (!executor) {
    throw new Error(`Unknown CLI provider: "${provider}". Supported: ${Object.keys(EXECUTORS).join(", ")}`);
  }
  const resolved = resolveCliExecution(provider, prompt, options);
  try {
    const result = await executor(resolved.prompt, resolved.options);
    return {
      ...result,
      warnings: [...resolved.warnings, ...(result.warnings ?? [])],
    };
  } finally {
    if (resolved.imageTempDir) {
      rmSync(resolved.imageTempDir, { recursive: true, force: true });
    }
  }
}

export { buildCliPrompt };

export function startCliSession(
  provider: CliProvider,
  options: CliExecuteOptions & { systemPrompt?: string } = {},
): CliSessionHandle {
  if (!EXECUTORS[provider]) {
    throw new Error(`Unknown CLI provider: "${provider}". Supported: ${Object.keys(EXECUTORS).join(", ")}`);
  }

  const sessionId = randomUUID();
  cliSessions.set(sessionId, {
    sessionId,
    provider,
    systemPrompt: options.systemPrompt,
    options: {
      model: options.model,
      timeout: options.timeout,
      cwd: options.cwd,
      env: options.env,
      yolo: options.yolo,
      systemPrompt: options.systemPrompt,
      reasoningEffort: options.reasoningEffort,
      temperature: options.temperature,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      maxTokens: options.maxTokens,
      enableThinking: options.enableThinking,
      thinkingBudget: options.thinkingBudget,
    },
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return { sessionId, provider };
}

export function getCliSession(sessionId: string): CliSessionState | null {
  return cliSessions.get(sessionId) ?? null;
}

export function closeCliSession(sessionId: string): boolean {
  return cliSessions.delete(sessionId);
}

export async function executeCliSessionTurn(
  sessionId: string,
  userInput: string,
  options: Partial<CliExecuteOptions> = {},
): Promise<CliSessionTurnResult> {
  const trimmedInput = userInput.trim();
  if (!trimmedInput) {
    throw new Error("CLI session turn requires non-empty user input.");
  }

  const session = getCliSessionOrThrow(sessionId);
  const prompt = buildCliSessionPrompt(session, trimmedInput);
  const result = await executeCli(session.provider, prompt, {
    ...session.options,
    ...options,
  });

  session.messages.push(
    { role: "user", content: trimmedInput },
    { role: "assistant", content: result.text },
  );
  session.updatedAt = Date.now();

  return {
    ...result,
    sessionId: session.sessionId,
  };
}

export async function executeCliSessionTurnStreaming(
  sessionId: string,
  userInput: string,
  options: Partial<CliExecuteOptions> & { onChunk: (chunk: string) => void },
): Promise<CliSessionTurnResult> {
  const trimmedInput = userInput.trim();
  if (!trimmedInput) {
    throw new Error("CLI session turn requires non-empty user input.");
  }

  const session = getCliSessionOrThrow(sessionId);
  const prompt = buildCliSessionPrompt(session, trimmedInput);
  const result = await executeCliStreaming(session.provider, prompt, {
    ...session.options,
    ...options,
  });

  session.messages.push(
    { role: "user", content: trimmedInput },
    { role: "assistant", content: result.text },
  );
  session.updatedAt = Date.now();

  return {
    ...result,
    sessionId: session.sessionId,
  };
}

/** 忽略 gh 版本更新提示行 */
function filterNoiseLine(line: string): boolean {
  return (
    !line.includes("A new release of gh is available") &&
    !line.includes("To upgrade, run:") &&
    !line.includes("https://github.com/cli/cli/releases")
  );
}

/**
 * 流式执行 Copilot CLI，通过 onChunk 回调逐块返回输出
 * 使用 spawn 替代 exec，不缓冲 stdout
 */
export function executeCliStreaming(
  provider: CliProvider,
  prompt: string,
  options: CliExecuteOptions & { onChunk: (chunk: string) => void }
): Promise<CliExecuteResult> {
  const resolved = resolveCliExecution(provider, prompt, options);
  const executor = EXECUTORS[provider];

  const cleanupImageTempDir = () => {
    if (resolved.imageTempDir) {
      rmSync(resolved.imageTempDir, { recursive: true, force: true });
    }
  };

  const withCleanup = <T>(promise: Promise<T>): Promise<T> =>
    promise.finally(cleanupImageTempDir);

  if (provider === "gemini") {
    return withCleanup(
      executeGeminiStreaming(resolved.prompt, resolved.options as CliExecuteOptions & { onChunk: (chunk: string) => void })
        .then((result) => ({ ...result, warnings: [...resolved.warnings, ...(result.warnings ?? [])] }))
    );
  }
  if (provider === "codex") {
    return withCleanup(
      executor(resolved.prompt, resolved.options).then((result) => {
        const merged = { ...result, warnings: [...resolved.warnings, ...(result.warnings ?? [])] };
        if (merged.text) options.onChunk(merged.text);
        return merged;
      })
    );
  }
  if (provider === "claude") {
    return withCleanup(
      executor(resolved.prompt, resolved.options).then((result) => {
        const merged = { ...result, warnings: [...resolved.warnings, ...(result.warnings ?? [])] };
        if (merged.text) options.onChunk(merged.text);
        return merged;
      })
    );
  }
  if (provider === "agy" || provider === "qoder" || provider === "opencode" || provider === "grok") {
    return withCleanup(
      executor(resolved.prompt, resolved.options).then((result) => {
        const merged = { ...result, warnings: [...resolved.warnings, ...(result.warnings ?? [])] };
        if (merged.text) options.onChunk(merged.text);
        return merged;
      })
    );
  }
  if (provider !== "copilot") {
    return withCleanup(
      executor(resolved.prompt, resolved.options).then((result) => ({
        ...result,
        warnings: [...resolved.warnings, ...(result.warnings ?? [])],
      }))
    );
  }

  const {
    model,
    timeout = 120_000,
    cwd = process.cwd(),
    yolo = true,
    onChunk,
  } = resolved.options as CliExecuteOptions & { onChunk: (chunk: string) => void };

  return withCleanup(new Promise<CliExecuteResult>((resolve, reject) => {
    const args = [
      "copilot", "--",
      "-p", resolved.prompt,
      "--silent",
      "--disable-builtin-mcps",
    ];
    if (model) { args.push("--model"); args.push(model); }
    if (yolo) args.push("--yolo");

    const start = Date.now();
    const proc = spawn("gh", args, {
      cwd,
      env: buildCliProcessEnv(resolved.options.env),
    });

    const stdout = createUtf8Collector();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Copilot CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = stdout.write(data);
      // 过滤噪音行后再推送
      const cleaned = chunk
        .split("\n")
        .filter(filterNoiseLine)
        .join("\n");
      if (cleaned) onChunk(cleaned);
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const raw = stdout.end();
      if (code !== 0 && code !== null) {
        reject(new Error(`Copilot CLI exited with code ${code}`));
        return;
      }
      const text = raw
        .split("\n")
        .filter(filterNoiseLine)
        .join("\n")
        .trim();
      resolve({
        text,
        raw,
        elapsed: Date.now() - start,
        warnings: [...resolved.warnings],
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  }));
}

function executeGeminiStreaming(
  prompt: string,
  options: CliExecuteOptions & { onChunk: (chunk: string) => void }
): Promise<CliExecuteResult> {
  const {
    model = "gemini-3-flash-preview",
    timeout = 120_000,
    cwd = process.cwd(),
    yolo = true,
    onChunk,
  } = options;

  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "-m", model];
    if (yolo) args.push("--yolo");
    args.push("-e", "none");

    const start = Date.now();
    const proc = spawn("gemini", args, {
      cwd,
      env: buildCliProcessEnv({
        ...options.env,
        NODE_OPTIONS: "--no-deprecation",
      }),
    });

    const stdout = createUtf8Collector();
    const stderr = createUtf8Collector();
    let lineBuffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flushLineBuffer = () => {
      const trimmed = lineBuffer.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        const text = extractGeminiEventText(event);
        if (text) onChunk(text);
      } catch {
        // ignore partial or malformed lines
      }
      lineBuffer = "";
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Gemini CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = stdout.write(data);
      lineBuffer += chunk;

      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line);
            const text = extractGeminiEventText(event);
            if (text) onChunk(text);
          } catch {
            // ignore malformed lines
          }
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr.write(data);
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      lineBuffer += stdout.finish();
      const raw = stdout.text;
      const stderrText = stderr.end();
      flushLineBuffer();

      if (code !== 0 && code !== null) {
        reject(new Error(`Gemini CLI exited with code ${code}\nstderr: ${stderrText}`));
        return;
      }

      resolve({
        text: parseGeminiStreamJson(raw),
        raw,
        elapsed: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
