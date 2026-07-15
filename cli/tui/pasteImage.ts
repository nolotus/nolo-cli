import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { toErrorMessage } from "../../core/errorMessage";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

const IMAGE_EXTENSION_SET = new Set<string>(IMAGE_EXTENSIONS.map((ext) => ext.toLowerCase()));

const MIME_BY_EXTENSION: Record<ImageExtension, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Phase A 默认大小上限。
 * 8 MB 是经验值:大部分截图 < 5 MB,iPhone HEIC 导出 jpg < 4 MB,
 * base64 编码后约 11 MB JSON payload,不会让 fetch / stream 卡顿。
 * 超出后会被静默忽略并提示(每个 path 在当前 session 内只提示一次)。
 */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type AttachedImage = {
  dataUrl: string;
  mime: string;
  filename: string;
  sizeBytes: number;
  sourcePath: string;
};

export type DetectedImageToken = {
  /** 原始 paste 进来的 token,保留 \ 转义形式,用于 stripImageTokens 在原 input 里匹配 */
  raw: string;
  /** 反斜杠转义解析后的字面值,用于 existsSync / 扩展名判定 / readFile */
  resolvedPath: string;
};

export type ImageReadErrorCode =
  | "not-found"
  | "is-directory"
  | "permission-denied"
  | "too-large"
  | "unsupported-extension"
  | "io-error";

export class ImageReadError extends Error {
  readonly code: ImageReadErrorCode;
  readonly path: string;
  constructor(code: ImageReadErrorCode, path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.name = "ImageReadError";
  }
}

function extnameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * 把 ~ 展开成用户家目录,绝对路径保持原样,相对路径基于 cwd 解析。
 * 不会做 file:// 或 URL 解码,留给上层 detectImagePaths。
 */
export function resolveImageSource(rawPath: string, cwd: string): string {
  let candidate = rawPath.trim();
  if (!candidate) return candidate;
  if (candidate === "~") return homedir();
  if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return homedir() + candidate.slice(1);
  }
  if (isAbsolute(candidate)) return candidate;
  return resolve(cwd, candidate);
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION_SET.has(extnameOf(path));
}

/**
 * 从一行输入里检测可能作为 image attachment 的 token。
 *
 * 规则(平衡考虑):
 * - 必须是图片扩展名 (png/jpg/jpeg/gif/webp),其他文件不抽
 * - 必须存在(用 existsSync 探测,快速失败)
 * - 一行内可能有多个路径,按 token 拆分,不解析上下文
 * - 引号("...","'...")包住的整段当一段处理,避免切到中间
 * - 反斜杠转义(`\ `, `\\`)按 shell 风格解析(iTerm2 / WezTerm 默认 paste 行为)
 * - ~/xxx、/abs、./xxx、../xxx 都解析;不是图片扩展名时返回空数组
 *
 * 不做 image MIME 嗅探(binary 文件头):iTerm2/WezTerm 拖图走的
 * 是绝对路径,不是 inline base64,这里只关心路径这一层。
 */
export function detectImagePaths(line: string, cwd: string): DetectedImageToken[] {
  const tokens = tokenizePasteLine(line);
  const out: DetectedImageToken[] = [];
  for (const token of tokens) {
    if (!token.raw) continue;
    const resolved = resolveImageSource(token.decoded, cwd);
    if (!isImagePath(resolved)) continue;
    if (!existsSync(resolved)) continue;
    out.push({ raw: token.raw, resolvedPath: resolved });
  }
  return out;
}

type Tokenized = { raw: string; decoded: string };

/**
 * 把 paste 行切成 token,支持 shell-style 反斜杠转义。
 *
 * 兼容 iTerm2 / WezTerm 在 paste 文件路径时把空格转义成 `\ `
 * 的默认行为。如果不做这一步,中文 / 含空格的 Finder 文件名会被切碎。
 *
 * - `\ ` `\\` `\"` `\'` 都按 bash 风格解码(字面 char)
 * - `"..."` `'...'` 内的 token 不再拆分空格
 * - 引号外用空白分隔
 *
 * 返回 { raw, decoded } 配对:`raw` 保留原始(用于 stripImageTokens 在
 * 原 input 上做 regex replace),`decoded` 是 escape 解析后的字面
 * 路径(用于 existsSync / readFile)。
 */
function tokenizePasteLine(line: string): Tokenized[] {
  const tokens: Tokenized[] = [];
  let rawBuf = "";
  let decBuf = "";
  let quote: string | null = null;

  const push = () => {
    if (rawBuf.length > 0) {
      tokens.push({ raw: rawBuf, decoded: decBuf });
      rawBuf = "";
      decBuf = "";
    }
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (quote) {
      if (ch === "\\" && next !== undefined) {
        rawBuf += ch + next;
        decBuf += next;
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        rawBuf += ch;
        continue;
      }
      rawBuf += ch;
      decBuf += ch;
      continue;
    }

    // 引号外:反斜杠 + 空白 → 合并 token(iTerm2 / WezTerm paste 行为)
    if (ch === "\\" && next !== undefined && /\s/.test(next)) {
      rawBuf += ch + next;
      decBuf += next;
      i++;
      continue;
    }
    // 引号外:双反斜杠 → 单反斜杠
    if (ch === "\\" && next === "\\") {
      rawBuf += "\\\\";
      decBuf += "\\";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      rawBuf += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    rawBuf += ch;
    decBuf += ch;
  }
  push();
  return tokens;
}

/**
 * 把图片读成 base64 data URL,做大小/MIME 校验。
 * 错误用 ImageReadError 表达,调用方按 code 决定提示方式。
 */
export async function readImageAsDataUrl(
  absolutePath: string,
  options: { maxBytes?: number } = {}
): Promise<AttachedImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  let stats;
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    throw classifyFsError(error, absolutePath);
  }
  if (stats.isDirectory()) {
    throw new ImageReadError(
      "is-directory",
      absolutePath,
      `path is a directory, not an image: ${absolutePath}`
    );
  }
  const ext = extnameOf(absolutePath) as ImageExtension | "";
  if (!ext || !(IMAGE_EXTENSION_SET.has(ext))) {
    throw new ImageReadError(
      "unsupported-extension",
      absolutePath,
      `unsupported image extension: .${ext || "(none)"}`
    );
  }
  if (stats.size > maxBytes) {
    throw new ImageReadError(
      "too-large",
      absolutePath,
      `image too large: ${formatBytes(stats.size)} (limit ${formatBytes(maxBytes)})`
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (error) {
    throw classifyFsError(error, absolutePath);
  }

  const mime = MIME_BY_EXTENSION[ext as ImageExtension];
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  return {
    dataUrl,
    mime,
    filename: basenameOf(absolutePath),
    sizeBytes: buffer.byteLength,
    sourcePath: absolutePath,
  };
}

function classifyFsError(error: unknown, path: string): ImageReadError {
  const code = (error as { code?: string } | null)?.code;
  const message = toErrorMessage(error);
  switch (code) {
    case "ENOENT":
      return new ImageReadError("not-found", path, `image not found: ${path}`);
    case "EACCES":
    case "EPERM":
      return new ImageReadError(
        "permission-denied",
        path,
        `cannot read image (permission denied): ${path}`
      );
    case "EISDIR":
      return new ImageReadError(
        "is-directory",
        path,
        `path is a directory, not an image: ${path}`
      );
    default:
      return new ImageReadError("io-error", path, `failed to read image: ${message}`);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function summarizeAttachment(img: AttachedImage): string {
  return `📎 ${img.filename} (${formatBytes(img.sizeBytes)})`;
}

/**
 * 合并已存的附件和刚读到的新附件,按 sourcePath 去重。
 *
 * 语义:
 * - 同 sourcePath 的项,incoming 覆盖 existing(让 chat 路径重读后的 dataUrl 生效)
 * - 顺序:existing 中独有的项保持原位,新项(incoming 中独有的 + 被覆盖的项)按
 *   出现顺序追加到末尾
 *
 * 纯函数,无副作用,容易测试。
 */
export function mergeAttachedImages(
  existing: AttachedImage[],
  incoming: AttachedImage[]
): AttachedImage[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return [...incoming];
  const incomingByPath = new Map<string, AttachedImage>();
  for (const img of incoming) incomingByPath.set(img.sourcePath, img);
  const out: AttachedImage[] = [];
  const seen = new Set<string>();
  for (const img of existing) {
    if (seen.has(img.sourcePath)) continue;
    const override = incomingByPath.get(img.sourcePath);
    out.push(override ?? img);
    seen.add(img.sourcePath);
  }
  for (const img of incoming) {
    if (seen.has(img.sourcePath)) continue;
    out.push(img);
    seen.add(img.sourcePath);
  }
  return out;
}

/**
 * 批量读图片:逐个 readImageAsDataUrl,把成功的放进 images,失败路径放进 failures。
 * 失败路径默认每个只回调一次(避免一行里同一 path 报两次)。
 *
 * 用法:
 * - chat 路径:paths 已经是绝对路径,不需要 resolve
 * - /attach 路径:传 resolve 把 ~ / 相对路径解析成绝对路径
 *
 * 这个 helper 把"读 + 报错提示 + dedupe 失败"集中处理,workspace 不需要再写 try/catch 循环。
 */
export type ReadImagePathsOptions = {
  resolve?: (raw: string) => string;
  onSuccess?: (img: AttachedImage) => void;
  onFailure?: (resolvedPath: string, error: Error) => void;
  maxBytes?: number;
};

export type ReadImagePathsResult = {
  images: AttachedImage[];
  failures: string[];
};

export async function readImagePaths(
  paths: string[],
  options: ReadImagePathsOptions = {}
): Promise<ReadImagePathsResult> {
  const resolve = options.resolve ?? ((p: string) => p);
  const reportedFailures = new Set<string>();
  const images: AttachedImage[] = [];
  const failures: string[] = [];
  for (const raw of paths) {
    const absolute = resolve(raw);
    try {
      const img = await readImageAsDataUrl(absolute, {
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      });
      images.push(img);
      options.onSuccess?.(img);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!reportedFailures.has(absolute)) {
        reportedFailures.add(absolute);
        failures.push(absolute);
        options.onFailure?.(absolute, err);
      }
    }
  }
  return { images, failures };
}