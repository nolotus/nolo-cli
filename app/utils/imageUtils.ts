// 文件路径: utils/imageUtils.ts
import imageCompression from "browser-image-compression";

/**
 * 前端图片压缩配置（只包含我们实际用到的字段）。
 * 可以按需扩展字段。
 */
export interface ImageCompressionOptions {
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
  useWebWorker?: boolean;
  initialQuality?: number;
  alwaysKeepResolution?: boolean;
}

/**
 * 默认压缩参数：
 * - 体积控制在 ~1.5MB 内
 * - 最长边 1400 像素
 * - 初始质量 0.9（画质较高）
 * - 使用 WebWorker 避免主线程卡顿
 */
const DEFAULT_COMPRESSION_OPTIONS: Required<
  Pick<
    ImageCompressionOptions,
    "maxSizeMB" | "maxWidthOrHeight" | "useWebWorker" | "initialQuality"
  >
> = {
  maxSizeMB: 1.5,
  maxWidthOrHeight: 1400,
  useWebWorker: true,
  initialQuality: 0.9,
};

const BYTES_PER_MB = 1024 * 1024;

const toMegabytes = (bytes: number): number => bytes / BYTES_PER_MB;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 解析 dataURL，提取 mime 和 base64 数据部分。
 */
const parseDataUrl = (
  dataUrl: string
): { mime: string; base64: string } | null => {
  const trimmed = dataUrl.trim();
  const parts = trimmed.split(",");

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    console.warn("[imageUtils] parseDataUrl: invalid data URL", {
      hasHeader: !!parts[0],
      hasBody: !!parts[1],
    });
    return null;
  }

  const header = parts[0];
  const base64 = parts[1];

  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch?.[1];

  if (!mime) {
    console.warn("[imageUtils] parseDataUrl: cannot extract mime from", header);
    return null;
  }

  return { mime, base64 };
};

/**
 * 将 data URL 字符串转回 File 对象。
 * @param dataUrl 形如 "data:image/png;base64,..." 的字符串
 * @param filename 生成 File 时使用的文件名
 * @returns File 对象，失败时返回 null
 */
export function dataURLtoFile(
  dataUrl: string,
  filename: string
): File | null {
  try {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return null;

    const { mime, base64 } = parsed;

    const binaryString = atob(base64);
    const length = binaryString.length;
    const u8arr = new Uint8Array(length);

    for (let i = 0; i < length; i++) {
      u8arr[i] = binaryString.charCodeAt(i);
    }

    return new File([u8arr], filename, { type: mime });
  } catch (error) {
    console.error("[imageUtils] Error converting data URL to File:", error);
    return null;
  }
}

const normalizeCompressedFile = (sourceFile: File, compressed: Blob | File): File => {
  if (compressed instanceof File) {
    return compressed;
  }

  return new File([compressed], sourceFile.name, {
    type: compressed.type || sourceFile.type || "application/octet-stream",
    lastModified: sourceFile.lastModified || Date.now(),
  });
};

export async function compressImageFile(
  imageFile: File,
  options?: ImageCompressionOptions
): Promise<File> {
  const mergedOptions: ImageCompressionOptions = {
    ...DEFAULT_COMPRESSION_OPTIONS,
    ...options,
  };

  const originalSizeMB = toMegabytes(imageFile.size);
  const targetSizeMB =
    mergedOptions.maxSizeMB ?? DEFAULT_COMPRESSION_OPTIONS.maxSizeMB;

  console.log(
    `[imageUtils] compressImageFile: original size = ${originalSizeMB.toFixed(
      2
    )} MB`
  );

  if (originalSizeMB <= targetSizeMB) {
    console.log(
      "[imageUtils] compressImageFile: image already smaller than target, skip compression"
    );
    return imageFile;
  }

  try {
    const compressedBlob = await imageCompression(imageFile, mergedOptions);
    const compressedFile = normalizeCompressedFile(imageFile, compressedBlob);
    const compressedSizeMB = toMegabytes(compressedFile.size);

    console.log(
      `[imageUtils] compressImageFile: compressed size = ${compressedSizeMB.toFixed(
        2
      )} MB (target <= ${targetSizeMB.toFixed(2)} MB)`
    );

    if (compressedFile.size >= imageFile.size) {
      console.log(
        "[imageUtils] compressImageFile: compressed file is not smaller, return original"
      );
      return imageFile;
    }

    return compressedFile;
  } catch (error) {
    console.error("[imageUtils] compressImageFile failed:", error);
    return imageFile;
  }
}

/**
 * 压缩一张 dataURL 图片。
 * 使用 browser-image-compression 库。
 *
 * @param imageDataUrl 原始图片的 dataURL（Base64）
 * @param options 可选的压缩参数，会覆盖默认值
 * @returns 压缩后的 dataURL；如果压缩失败或不划算，会返回原始 dataURL
 */
export async function compressImage(
  imageDataUrl: string,
  options?: ImageCompressionOptions
): Promise<string> {
  // 为转换生成一个“相对唯一”的文件名
  const timestamp = Date.now();
  const filename = `image_${timestamp}.png`; // 实际类型由 dataURL 决定

  const imageFile = dataURLtoFile(imageDataUrl, filename);

  if (!imageFile) {
    console.warn(
      "[imageUtils] compressImage: cannot convert data URL to File, return original"
    );
    return imageDataUrl;
  }

  try {
    const compressedFile = await compressImageFile(imageFile, options);
    if (compressedFile === imageFile) {
      console.log(
        "[imageUtils] compressImage: file-based compression kept original image"
      );
      return imageDataUrl;
    }

    const compressedDataUrl =
      await imageCompression.getDataUrlFromFile(compressedFile);

    return compressedDataUrl;
  } catch (error) {
    console.error("[imageUtils] compressImage failed:", error);
    return imageDataUrl;
  }
}

/**
 * 等待 remote /file/content/:fileId 对应的图片 URL 可用。
 * 通过创建 <img> 去加载这个 URL，避免 CORS 问题。
 *
 * 成功：在 maxWaitMs 内，某次加载 onload 触发。
 * 失败：超时或每次都是 onerror。
 */
export interface WaitForFileReadyOptions {
  /** 最大等待时间（毫秒），默认 4000ms */
  maxWaitMs?: number;
  /** 每次重试之间的间隔时间（毫秒），默认 250ms */
  intervalMs?: number;
}

const appendNoCacheQuery = (url: string): string => {
  const stamp = `_t=${Date.now()}`;
  return url.includes("?") ? `${url}&${stamp}` : `${url}?${stamp}`;
};

const tryLoadImage = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const img = new Image();

    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
    };

    img.onload = () => {
      cleanup();
      resolve(true);
    };

    img.onerror = () => {
      cleanup();
      resolve(false);
    };

    img.src = url;
  });

export const waitForFileReady = async (
  url: string,
  {
    maxWaitMs = 4000,
    intervalMs = 250,
  }: WaitForFileReadyOptions = {}
): Promise<boolean> => {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const tryUrl = appendNoCacheQuery(url);
    const ok = await tryLoadImage(tryUrl);

    if (ok) {
      console.debug("[imageUtils] waitForFileReady: image loaded for", url);
      return true;
    }

    await sleep(intervalMs);
  }

  console.warn("[imageUtils] waitForFileReady: timeout for", url);
  return false;
};
