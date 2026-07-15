/**
 * Local machine worker for ChatGPT web image generation via Oracle browser.
 * Invoked from connector agent.run when payload.meta.localJob === "chatgptWebImageGenerate".
 * No OpenAI Images API — uses npx @steipete/oracle --generate-image, then uploads to Nolo FS.
 */

import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isRecord } from "./core/isRecord";
import { asRecordOrEmpty } from "./core/recordOrEmpty";
import { asTrimmedString } from "./core/trimmedString";

import type { CliFetchImpl } from "./cliFetch";
import { parseUserIdFromAuthToken } from "./cliEnvHelpers";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import {
  readPipeText,
  spawnProcess,
  type SpawnFn,
} from "./processSpawn";

export const CHATGPT_WEB_IMAGE_LOCAL_JOB = "chatgptWebImageGenerate" as const;

export type ChatgptWebImageGalleryRawData = {
  text: string;
  imageCount: number;
  files: Array<{
    fileId: string;
    metadata: Record<string, unknown>;
  }>;
};

export type ChatgptWebImageLocalJobInput = {
  prompt: string;
  userAuthToken?: string;
  serverBase?: string;
};

export type ChatgptWebImageLocalJobResult = {
  rawData: ChatgptWebImageGalleryRawData;
  outPath: string;
  fileId: string;
};

export type ChatgptWebImageLocalJobDeps = {
  spawn?: SpawnFn;
  fetchImpl?: CliFetchImpl;
  lockPath?: string;
  outDir?: string;
  homedir?: () => string;
  now?: () => number;
};

export function readChatgptWebImageLocalJobMeta(
  payload: unknown,
): ChatgptWebImageLocalJobInput | null {
  if (!isRecord(payload)) return null;
  const meta = isRecord(payload.meta) ? payload.meta : null;
  if (!meta || meta.localJob !== CHATGPT_WEB_IMAGE_LOCAL_JOB) return null;

  const prompt = asTrimmedString(meta.prompt);
  const userAuthToken = asTrimmedString(meta.userAuthToken);
  const serverBase = asTrimmedString(meta.serverBase);

  return {
    prompt,
    ...(userAuthToken ? { userAuthToken } : {}),
    ...(serverBase ? { serverBase } : {}),
  };
}

function defaultLockPath(home: string) {
  return join(home, ".nolo", "chatgpt-web-image.lock");
}

function defaultOutDir(home: string) {
  return join(home, "nolo-image-lab", "out");
}

/**
 * Single-flight lock via exclusive create (O_EXCL / flag wx).
 * Concurrent jobs reject with a human-readable Chinese error.
 */
export function acquireChatgptWebImageLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "EEXIST") {
      throw new Error("ChatGPT 网页生图任务正在进行中，请稍后再试（锁文件占用）");
    }
    throw error;
  }
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best-effort release.
    }
  };
}

async function runOracleGenerateImage(args: {
  prompt: string;
  outPath: string;
  spawn: SpawnFn;
}): Promise<void> {
  const proc = args.spawn({
    cmd: [
      "npx",
      "-y",
      "@steipete/oracle",
      "--engine",
      "browser",
      "--browser-manual-login",
      "--browser-model-strategy",
      "current",
      "--generate-image",
      args.outPath,
      "-p",
      args.prompt,
      "--browser-timeout",
      "15m",
      "--browser-input-timeout",
      "180s",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readPipeText(proc.stdout),
    readPipeText(proc.stderr),
  ]);

  if (exitCode !== 0) {
    const detail = (stderr || stdout || "").trim().slice(0, 800);
    throw new Error(
      detail
        ? `ChatGPT 网页生图失败（oracle exit ${exitCode}）：${detail}`
        : `ChatGPT 网页生图失败（oracle exit ${exitCode}）`,
    );
  }
}

function assertOutputImage(outPath: string) {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(outPath);
  } catch {
    throw new Error(`ChatGPT 网页生图未产出文件：${outPath}`);
  }
  if (!st.isFile() || st.size <= 0) {
    throw new Error(`ChatGPT 网页生图文件无效或为空：${outPath}`);
  }
}

async function uploadPngToNoloFs(args: {
  outPath: string;
  prompt: string;
  userAuthToken: string;
  serverBase: string;
  userId: string;
  fetchImpl: CliFetchImpl;
}): Promise<{ fileId: string; metadata: Record<string, unknown> }> {
  const bytes = readFileSync(args.outPath);
  const form = new FormData();
  const fileName = basename(args.outPath) || "chatgpt-web.png";
  form.append(
    "file",
    new Blob([bytes], { type: "image/png" }),
    fileName,
  );
  form.append(
    "metadata",
    JSON.stringify({
      type: "file",
      fileCategory: "image",
      ownerType: "user",
      userId: args.userId,
      source: "chatgpt-web-image",
      model: "chatgpt-web",
      prompt: args.prompt,
      tags: ["ai-generated", "chatgpt-web", "image"],
    }),
  );
  form.append("userId", args.userId);
  form.append("ownerType", "user");
  form.append("ownerId", args.userId);

  const base = args.serverBase.replace(/\/+$/, "") || DEFAULT_NOLO_SERVER_URL;
  const url = `${base}/api/v1/db/upload`;
  const headers: Record<string, string> = {};
  if (args.userAuthToken) {
    headers.Authorization = `Bearer ${args.userAuthToken}`;
  }

  const response = await args.fetchImpl(url, {
    method: "POST",
    headers,
    body: form,
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const errField = body.error;
    const message =
      (typeof errField === "string" && errField) ||
      (isRecord(errField) && typeof errField.message === "string" && errField.message) ||
      (typeof body.details === "string" && body.details) ||
      `HTTP ${response.status}`;
    throw new Error(`上传生图结果到 Nolo FS 失败：${message}`);
  }

  const fileId = asTrimmedString(body.fileId);
  if (!fileId) {
    throw new Error("上传生图结果成功但响应缺少 fileId");
  }

  // Bare fileId (ULID / id) — same shape as openaiImageHandler files[].fileId
  // from saveBufferAsFile; readFileContent expects this bare id.
  const metadata = asRecordOrEmpty(body.metadata);
  return { fileId, metadata };
}

export async function runChatgptWebImageLocalJob(
  input: ChatgptWebImageLocalJobInput,
  deps: ChatgptWebImageLocalJobDeps = {},
): Promise<ChatgptWebImageLocalJobResult> {
  const prompt = asTrimmedString(input.prompt);
  if (!prompt) {
    throw new Error("缺少生图 prompt（payload.meta.prompt 必填）");
  }

  const home = (deps.homedir ?? homedir)();
  const lockPath = deps.lockPath ?? defaultLockPath(home);
  const outDir = deps.outDir ?? defaultOutDir(home);
  const release = acquireChatgptWebImageLock(lockPath);

  try {
    mkdirSync(outDir, { recursive: true });
    const stamp = (deps.now ?? Date.now)();
    const outPath = join(outDir, `chatgpt-web-${stamp}.png`);

    await runOracleGenerateImage({
      prompt,
      outPath,
      spawn: deps.spawn ?? spawnProcess,
    });
    assertOutputImage(outPath);

    const userAuthToken = input.userAuthToken?.trim() || "";
    const userId = parseUserIdFromAuthToken(userAuthToken) || "default";
    const serverBase =
      (input.serverBase?.trim() || DEFAULT_NOLO_SERVER_URL).replace(/\/+$/, "");

    const uploaded = await uploadPngToNoloFs({
      outPath,
      prompt,
      userAuthToken,
      serverBase,
      userId,
      fetchImpl: deps.fetchImpl ?? fetch,
    });

    const rawData: ChatgptWebImageGalleryRawData = {
      text: `已生成 1 张图片。`,
      imageCount: 1,
      files: [
        {
          fileId: uploaded.fileId,
          metadata: {
            ...uploaded.metadata,
            prompt,
            model: "chatgpt-web",
          },
        },
      ],
    };

    return {
      rawData,
      outPath,
      fileId: uploaded.fileId,
    };
  } finally {
    release();
  }
}
