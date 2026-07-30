import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type HeadTailClipResult = {
  content: string;
  clipped: boolean;
  logPath?: string;
  originalBytes: number;
};

export function clipHeadAndTail(
  rawContent: string,
  options: {
    maxHeadBytes?: number;
    maxTailBytes?: number;
    maxTotalBytes?: number;
    saveTempLog?: boolean;
    toolCallId?: string;
  } = {}
): HeadTailClipResult {
  const maxHeadBytes = options.maxHeadBytes ?? 1000;
  const maxTailBytes = options.maxTailBytes ?? 2500;
  const maxTotalBytes = options.maxTotalBytes ?? 4000;

  const originalBytes = Buffer.byteLength(rawContent, "utf8");
  if (originalBytes <= maxTotalBytes) {
    return { content: rawContent, clipped: false, originalBytes };
  }

  const buf = Buffer.from(rawContent, "utf8");
  let headEnd = Math.min(maxHeadBytes, buf.length);
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) {
    headEnd--;
  }

  let tailStart = Math.max(0, buf.length - maxTailBytes);
  while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) {
    tailStart++;
  }

  if (tailStart < headEnd) {
    tailStart = headEnd;
  }

  const headStr = buf.toString("utf8", 0, headEnd);
  const tailStr = buf.toString("utf8", tailStart, buf.length);

  const elidedBytes = Math.max(0, originalBytes - headEnd - (buf.length - tailStart));

  let logPath: string | undefined = undefined;
  if (options.saveTempLog !== false) {
    try {
      const dir = join(tmpdir(), "nolo-tool-logs");
      mkdirSync(dir, { recursive: true });
      const safeId = (options.toolCallId || `tool-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
      logPath = join(dir, `${safeId}.log`);
      writeFileSync(logPath, rawContent, "utf8");
    } catch {
      // ignore write errors in restricted envs
    }
  }

  const logHint = logPath ? ` Full output saved to ${logPath}` : "";
  const notice = `\n\n[... truncated ${elidedBytes} bytes.${logHint}]\n\n`;

  return {
    content: `${headStr}${notice}${tailStr}`,
    clipped: true,
    logPath,
    originalBytes,
  };
}