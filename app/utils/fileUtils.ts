// 文件路径: app/utils/fileUtils.ts

import type { FileCategory } from "../types";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";

const fileConstructor =
  typeof globalThis !== "undefined" && typeof globalThis.File === "function"
    ? globalThis.File
    : undefined;

export const isImageMimeType = (value: unknown): value is string =>
  typeof value === "string" && value.toLowerCase().startsWith("image/");

const IMAGE_FILE_NAME_RE = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const VIDEO_FILE_NAME_RE = /\.(avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/i;
const AUDIO_FILE_NAME_RE = /\.(aac|flac|m4a|mp3|ogg|wav|weba)$/i;
const DOCUMENT_FILE_NAME_RE =
  /\.(csv|doc|docx|md|odt|pdf|ppt|pptx|rtf|txt|xls|xlsx)$/i;

export const isImageFileName = (value: unknown): value is string =>
  typeof value === "string" && IMAGE_FILE_NAME_RE.test(value.trim());

export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / Math.pow(1024, unitIndex);
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

const MIME_FORMAT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "text/plain": "TXT",
  "text/markdown": "MD",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WEBP",
  "image/gif": "GIF",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "audio/mpeg": "MP3",
  "audio/wav": "WAV",
  "audio/x-wav": "WAV",
  "audio/mp4": "M4A",
};

export const resolveFileFormatLabel = ({
  fileName,
  mimeType,
}: {
  fileName?: unknown;
  mimeType?: unknown;
}): string | null => {
  if (typeof fileName === "string") {
    const normalizedName = fileName.trim();
    const ext = normalizedName.includes(".")
      ? normalizedName.split(".").pop()?.trim().toUpperCase()
      : "";
    if (ext) return ext;
  }

  if (typeof mimeType === "string") {
    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (MIME_FORMAT_LABELS[normalizedMimeType]) {
      return MIME_FORMAT_LABELS[normalizedMimeType];
    }
    const [, subtype] = normalizedMimeType.split("/");
    if (subtype) {
      return subtype.split("+")[0]?.split(".").pop()?.toUpperCase() ?? null;
    }
  }

  return null;
};

export const getCompactFileMetaLabel = ({
  fileName,
  mimeType,
  fileSize,
}: {
  fileName?: unknown;
  mimeType?: unknown;
  fileSize?: unknown;
}): string | null => {
  const formatLabel = resolveFileFormatLabel({ fileName, mimeType });
  const finiteSize = asOptionalFiniteNumber(fileSize);
  const sizeLabel =
    finiteSize !== undefined ? formatFileSize(finiteSize) : null;

  if (formatLabel && sizeLabel) return `${formatLabel} · ${sizeLabel}`;
  return formatLabel ?? sizeLabel;
};

export const isVideoMimeType = (value: unknown): value is string =>
  typeof value === "string" && value.toLowerCase().startsWith("video/");

export const isAudioMimeType = (value: unknown): value is string =>
  typeof value === "string" && value.toLowerCase().startsWith("audio/");

export const isPdfMimeType = (value: unknown): value is string =>
  typeof value === "string" && value.toLowerCase() === "application/pdf";

export const isDocumentMimeType = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return (
    isPdfMimeType(normalized) ||
    normalized === "text/plain" ||
    normalized === "text/markdown" ||
    normalized === "text/csv" ||
    normalized === "application/msword" ||
    normalized ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalized === "application/vnd.ms-powerpoint" ||
    normalized ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    normalized === "application/vnd.ms-excel" ||
    normalized ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    normalized === "application/rtf" ||
    normalized === "application/vnd.oasis.opendocument.text"
  );
};

export const resolveFileCategory = ({
  mimeType,
  fileName,
}: {
  mimeType?: unknown;
  fileName?: unknown;
}): FileCategory => {
  if (isImageMimeType(mimeType) || isImageFileName(fileName)) return "image";
  if (isVideoMimeType(mimeType) || (typeof fileName === "string" && VIDEO_FILE_NAME_RE.test(fileName.trim()))) {
    return "video";
  }
  if (isAudioMimeType(mimeType) || (typeof fileName === "string" && AUDIO_FILE_NAME_RE.test(fileName.trim()))) {
    return "audio";
  }
  if (isDocumentMimeType(mimeType) || (typeof fileName === "string" && DOCUMENT_FILE_NAME_RE.test(fileName.trim()))) {
    return "document";
  }
  return "other";
};

export const isImageResourceLike = ({
  kind,
  mimeType,
  fileName,
  fileCategory,
}: {
  kind?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  fileCategory?: unknown;
}): boolean => {
  if (fileCategory === "image") return true;
  if (typeof kind === "string") {
    const normalizedKind = kind.toLowerCase();
    if (normalizedKind === "image" || isImageMimeType(normalizedKind)) {
      return true;
    }
  }

  return isImageMimeType(mimeType) || isImageFileName(fileName);
};

export const isBrowserFile = (value: unknown): value is File =>
  !!fileConstructor && value instanceof fileConstructor;

export const isImageFile = (value: unknown): value is File =>
  isBrowserFile(value) && isImageMimeType(value.type);

export const filterImageFiles = (values: Iterable<unknown>): File[] =>
  Array.from(values).filter(isImageFile);

/**
 * 按是否为图片拆分文件数组:
 * - 第 0 个数组是图片
 * - 第 1 个数组是非图片
 */
export function splitFiles(files: File[]): [File[], File[]] {
    return files.reduce(
        (acc, file) => {
            const index = isImageFile(file) ? 0 : 1;
            acc[index].push(file);
            return acc;
        },
        [[], []] as [File[], File[]]
    );
}

/**
 * 从 DataTransfer 中安全提取文件列表
 * 兼容 dt.items 和 dt.files 两种情况
 */
export function extractFilesFromDataTransfer(
    dt: DataTransfer | null
): File[] {
    if (!dt) return [];

    const files: File[] = [];

    if (dt.items && dt.items.length > 0) {
        for (const item of Array.from(dt.items)) {
            if (item.kind === "file") {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) return files;
    }

    if (dt.files && dt.files.length > 0) {
        return Array.from(dt.files);
    }

    return [];
}
