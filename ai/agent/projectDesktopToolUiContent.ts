import { isRecord } from "../../core/isRecord";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asOptionalTrimmedString } from "../../core/optionalString";

/** Max chars kept in projected tool content for UI expand (full model path is separate). */
export const DESKTOP_TOOL_UI_CONTENT_MAX_CHARS = 48_000;

export type ProjectDesktopToolUiContentArgs = {
  toolName?: string | null;
  /** Full tool result text from local runtime (preferred for expand). */
  content?: string | null;
  /** Compact event summary (legacy UI path). */
  summary?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  /** From tool-call event; used as shell command fallback. */
  argumentsPreview?: string | null;
};

function clipUiText(value: string, max = DESKTOP_TOOL_UI_CONTENT_MAX_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 20))}\n…[truncated for UI]`;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse local workspace shell content shape:
 *   stdout:\n...\n\nstderr:\n...\n\nexitCode: N
 * Fallback: whole string is stdout.
 */
export function parseShellToolTextContent(content: string): {
  stdout: string;
  stderr: string;
  exitCode?: number;
} {
  const text = content ?? "";
  if (!text.trim()) return { stdout: "", stderr: "" };

  const exitMatch = text.match(/(?:^|\n)exitCode:\s*(-?\d+)\s*$/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
  const body = (exitMatch ? text.slice(0, exitMatch.index) : text).replace(
    /\s+$/,
    "",
  );

  let stdout = "";
  let stderr = "";

  if (body.startsWith("stdout:\n") || body.includes("\nstdout:\n")) {
    const afterStdout = body.replace(/^[\s\S]*?stdout:\n/, "");
    if (afterStdout.includes("\n\nstderr:\n")) {
      const [out, err] = afterStdout.split("\n\nstderr:\n");
      stdout = out ?? "";
      stderr = err ?? "";
    } else if (afterStdout.startsWith("stderr:\n")) {
      stderr = afterStdout.slice("stderr:\n".length);
    } else {
      stdout = afterStdout;
    }
  } else if (body.startsWith("stderr:\n") || body.includes("\nstderr:\n")) {
    stderr = body.replace(/^[\s\S]*?stderr:\n/, "");
  } else {
    stdout = body;
  }

  return {
    stdout,
    stderr,
    ...(typeof exitCode === "number" && Number.isFinite(exitCode)
      ? { exitCode }
      : {}),
  };
}

function resolveShellCommand(
  metadata: Record<string, unknown>,
  argumentsPreview?: string | null,
): string {
  return (
    asOptionalTrimmedString(metadata.command) ||
    asOptionalTrimmedString(metadata.cmd) ||
    asOptionalTrimmedString(argumentsPreview) ||
    ""
  );
}

/**
 * Project desktop local-runtime tool events into message.content that UI viewers understand.
 * ExecShellViewer expects JSON: { command, stdout, stderr, exitCode, cwd? }.
 */
export function projectDesktopToolUiContent(
  args: ProjectDesktopToolUiContentArgs,
): string {
  const toolName = asOptionalTrimmedString(args.toolName) || "tool";
  const metadata = isRecord(args.metadata) ? args.metadata : {};
  const rawContent =
    typeof args.content === "string"
      ? args.content
      : typeof args.summary === "string"
        ? args.summary
        : typeof args.message === "string"
          ? args.message
          : "";

  if (toolName === "execShell") {
    const existing = tryParseJsonRecord(rawContent);
    if (
      existing &&
      (typeof existing.stdout === "string" ||
        typeof existing.command === "string" ||
        typeof existing.stderr === "string")
    ) {
      const command =
        asOptionalTrimmedString(existing.command) ||
        resolveShellCommand(metadata, args.argumentsPreview);
      return JSON.stringify({
        ...existing,
        command,
        cwd:
          asOptionalTrimmedString(existing.cwd) ||
          asOptionalTrimmedString(metadata.cwd) ||
          null,
        exitCode:
          asOptionalFiniteNumber(existing.exitCode) ??
          asOptionalFiniteNumber(metadata.exitCode),
      });
    }

    const parsed = parseShellToolTextContent(rawContent);
    const command = resolveShellCommand(metadata, args.argumentsPreview);
    return JSON.stringify({
      command,
      cwd: asOptionalTrimmedString(metadata.cwd) || null,
      stdout: clipUiText(parsed.stdout),
      stderr: clipUiText(parsed.stderr),
      exitCode:
        asOptionalFiniteNumber(metadata.exitCode) ?? parsed.exitCode,
      timedOut: metadata.timedOut === true,
      blocked: metadata.blocked === true,
    });
  }

  // readFile: CodePreviewViewer expects { filePath, content }. Desktop local
  // runtime returns plain file text + path in metadata — project that shape so
  // the UI does not show "Unknown" + empty NoloEditor chrome.
  if (toolName === "readFile" || toolName === "read_file") {
    const filePath =
      asOptionalTrimmedString(metadata.path) ||
      asOptionalTrimmedString(metadata.filePath) ||
      asOptionalTrimmedString(metadata.file_path) ||
      asOptionalTrimmedString(args.argumentsPreview) ||
      "";
    const body =
      (typeof args.content === "string" && args.content) ||
      (typeof args.summary === "string" && args.summary) ||
      (typeof args.message === "string" && args.message) ||
      "";
    return JSON.stringify({
      filePath,
      content: clipUiText(body),
      ...(asOptionalFiniteNumber(metadata.startLine) != null
        ? { startLine: asOptionalFiniteNumber(metadata.startLine) }
        : {}),
      ...(asOptionalFiniteNumber(metadata.endLine) != null
        ? { endLine: asOptionalFiniteNumber(metadata.endLine) }
        : {}),
      ...(asOptionalFiniteNumber(metadata.totalLines) != null
        ? { totalLines: asOptionalFiniteNumber(metadata.totalLines) }
        : {}),
      ...(metadata.truncated === true ? { truncated: true } : {}),
    });
  }

  // Non-shell: prefer full content so expand is not a useless summary line.
  const preferred =
    (typeof args.content === "string" && args.content) ||
    (typeof args.summary === "string" && args.summary) ||
    (typeof args.message === "string" && args.message) ||
    "";
  return clipUiText(preferred);
}
