import { clipCompactText } from "../../core/clipCompactText";
import { isRecord } from "../../core/isRecord";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { asTrimmedString } from "../../core/trimmedString";

const HIDDEN_ORCHESTRATOR_TOOL_NAMES: Record<string, true> = {};

const HIDDEN_SERVER_ONLY_BROWSER_TOOL_NAMES: Record<string, true> = {
  queryModelUsage: true,
  createAgentAutomation: true,
  notifyUser: true,
};

const DEFAULT_EXPANDED_TOOL_NAMES: Record<string, true> = {
  applyDiff: true,
  prepareAgentDraft: true,
  createAgent: true,
  geminiFlashImage: true,
  openAIGptImage: true,
  openAIGptImageGenerate: true,
  chatgptWebImageGenerate: true,
  openAIGptImageEdit: true,
  appDeploy: true,
  ziweiChart: true,
  runStreamingAgent: true,
  read_x_post: true,
  ui_ask_choice: true,
  createTable: true,
};

const SUMMARY_EMOJI_PREFIX =
  /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\[[vx!]\])\s*/u;

const SUMMARY_META_PREFIX = /^\[.*?\]\s*/;
const SUMMARY_COMMAND_PREFIX = /^command:\s*/i;

function cleanSummaryText(value: string): string {
  return value
    .replace(SUMMARY_META_PREFIX, "")
    .replace(SUMMARY_COMMAND_PREFIX, "")
    .replace(SUMMARY_EMOJI_PREFIX, "")
    .trim();
}

function formatStructuredSummary(
  summary: Record<string, unknown>,
  toolName?: string
): string {
  const total = asOptionalFiniteNumber(summary.total);
  const succeeded = asOptionalFiniteNumber(summary.succeeded);
  const failed = asOptionalFiniteNumber(summary.failed);

  const compactPairs = Object.entries(summary)
    .flatMap(([key, value]) =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? [`${key}: ${String(value)}`]
        : [],
    )
    .slice(0, 3);

  return compactPairs.join(" · ");
}

export function normalizeToolDisplaySummary(
  summary: unknown,
  toolName?: string
): string {
  if (typeof summary === "string") {
    const cleaned = cleanSummaryText(summary);
    if (cleaned) return cleaned;
  }

  if (isRecord(summary)) {
    const structured = cleanSummaryText(
      formatStructuredSummary(summary, toolName)
    );
    if (structured) return structured;
  }

  return cleanSummaryText(toolName || "");
}

export function isHiddenOrchestratorToolMessage(
  message: { role?: string; toolName?: string } | null | undefined
): boolean {
  return (
    message?.role === "tool" &&
    typeof message.toolName === "string" &&
    Boolean(HIDDEN_ORCHESTRATOR_TOOL_NAMES[message.toolName] ||
      HIDDEN_SERVER_ONLY_BROWSER_TOOL_NAMES[message.toolName])
  );
}

export function shouldToolMessageStartCollapsed(toolName?: string | null): boolean {
  const normalized = asTrimmedString(toolName);
  if (!normalized) return true;
  return !DEFAULT_EXPANDED_TOOL_NAMES[normalized];
}

/** Char threshold: tool body text above this is previewed until user expands. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 4_000;
/** Line threshold used with char limit for long dumps / shell / code. */
export const TOOL_OUTPUT_PREVIEW_LINES = 120;
/**
 * Content payload size that forces the tool row to start collapsed even for
 * tools that normally open (keeps huge JSON/logs out of the first paint).
 */
export const TOOL_FORCE_COLLAPSE_CONTENT_CHARS = 8_000;

export function measureToolText(text: string): { chars: number; lines: number } {
  if (!text) return { chars: 0, lines: 0 };
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return { chars: text.length, lines };
}

export function shouldPreviewToolText(
  text: string,
  charLimit: number = TOOL_OUTPUT_PREVIEW_CHARS,
  lineLimit: number = TOOL_OUTPUT_PREVIEW_LINES
): boolean {
  if (!text) return false;
  if (text.length > charLimit) return true;
  return measureToolText(text).lines > lineLimit;
}

/**
 * Build a short preview of long tool body text for default-collapsed DOM.
 * Prefer cutting on a newline so the truncated block stays readable.
 */
export function previewToolText(
  text: string,
  charLimit: number = TOOL_OUTPUT_PREVIEW_CHARS,
  lineLimit: number = TOOL_OUTPUT_PREVIEW_LINES
): {
  preview: string;
  truncated: boolean;
  totalChars: number;
  totalLines: number;
} {
  const { chars: totalChars, lines: totalLines } = measureToolText(text || "");
  if (!text) {
    return { preview: "", truncated: false, totalChars: 0, totalLines: 0 };
  }
  if (totalChars <= charLimit && totalLines <= lineLimit) {
    return { preview: text, truncated: false, totalChars, totalLines };
  }

  let preview = text.slice(0, Math.min(charLimit, text.length));
  const lastNl = preview.lastIndexOf("\n");
  if (lastNl > charLimit * 0.5) {
    preview = preview.slice(0, lastNl);
  }

  // Enforce line limit on the already char-trimmed slice.
  let lineCount = 1;
  let cutAt = preview.length;
  for (let i = 0; i < preview.length; i++) {
    if (preview.charCodeAt(i) === 10) {
      lineCount += 1;
      if (lineCount > lineLimit) {
        cutAt = i;
        break;
      }
    }
  }
  if (cutAt < preview.length) {
    preview = preview.slice(0, cutAt);
  }

  // Avoid empty preview for a single giant line.
  if (!preview && text.length > 0) {
    preview = text.slice(0, Math.min(charLimit, text.length));
  }

  return {
    preview,
    truncated: preview.length < text.length,
    totalChars,
    totalLines,
  };
}

/** Estimate content size without full stringify of huge objects when possible. */
export function estimateToolContentChars(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content).length;
  }
  if (Array.isArray(content)) {
    // Cheap upper bound: avoid deep walk of huge arrays on every render.
    try {
      return JSON.stringify(content).length;
    } catch {
      return content.length * 16;
    }
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Whether a tool row should start collapsed, including oversized payload force-collapse.
 * Confirm banners / errors stay open so the user can act.
 */
export function shouldToolMessageRowStartCollapsed(args: {
  toolName?: string | null;
  content?: unknown;
  isError?: boolean;
  forceOpen?: boolean;
}): boolean {
  if (args.forceOpen || args.isError) return false;
  const size = estimateToolContentChars(args.content);
  if (size >= TOOL_FORCE_COLLAPSE_CONTENT_CHARS) return true;
  return shouldToolMessageStartCollapsed(args.toolName);
}

type HandoffStatus = "running" | "failed" | "success";

export interface RunStreamingAgentHandoffPresentation {
  summary: string;
  inline: boolean;
  targetLabel: string;
  agentKey: string;
  inputSummary: string;
  statusLabel: string;
  targetDialogKey: string;
  targetSpaceId?: string;
}

const INPUT_SUMMARY_LIMIT = 180;
const KNOWN_AGENT_LABELS: Record<string, string> = {
  "agent-pub-01ECOMMERCEAG00000001PYQ2J": "电商商品参数助手",
  "agent-pub-01APPBUILDER00000001YAII3I": "应用构建助手",
};

function readString(...values: unknown[]): string {
  for (const value of values) {
    const trimmed = asOptionalTrimmedString(value);
    if (trimmed) return trimmed;
  }
  return "";
}

function compactText(value: unknown, fallback = ""): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : fallback;
  return clipCompactText(raw, INPUT_SUMMARY_LIMIT, "…");
}

function resolveStatusLabel(
  toolPayload: Record<string, unknown> | null | undefined,
  status: HandoffStatus
): string {
  const payloadStatus = readString(toolPayload?.status);
  if (status === "running" || payloadStatus === "running") return "处理中";
  if (status === "failed" || payloadStatus === "failed") return "交接失败";
  if (payloadStatus === "pending") return "等待中";
  return "已交接";
}

export function buildRunStreamingAgentHandoffPresentation(args: {
  rawData?: unknown;
  toolPayload?: unknown;
  isStreaming?: boolean;
  isError?: boolean;
}): RunStreamingAgentHandoffPresentation {
  const raw = asRecordOrEmpty(args.rawData);
  const payload = asRecordOrEmpty(args.toolPayload);
  const input = asRecordOrEmpty(payload.input);

  const agentKey = readString(raw.agentKey, input.agentKey);
  const agentName = readString(raw.agentName, input.agentName, KNOWN_AGENT_LABELS[agentKey]);
  const inline = raw.inline === true || raw.handoff === true;
  const targetLabel = agentName || agentKey || "Agent";
  const userInput = readString(raw.userInput, input.userInput, input.task);
  const status: HandoffStatus = args.isStreaming
    ? "running"
    : args.isError
      ? "failed"
      : "success";

  return {
    summary: `已交给 ${targetLabel} 处理`,
    inline,
    targetLabel,
    agentKey,
    inputSummary: compactText(userInput, "未记录输入摘要"),
    statusLabel: resolveStatusLabel(payload, status),
    targetDialogKey: readString(
      raw.dialogKey,
      raw.subDialogKey,
      payload.subDialogKey,
      payload.subDialogId
    ),
    targetSpaceId: readString(raw.spaceId, payload.spaceId) || undefined,
  };
}
