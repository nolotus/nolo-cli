import { canonicalizeToolName } from "../tools/toolNameAliases";

export interface ToolFailureGuardState {
  signature: string | null;
  count: number;
}

export interface ToolFailureGuardToolCall {
  function: {
    name: string;
    arguments?: unknown;
  };
}

function parseToolResult(content: string | null | undefined): any {
  if (typeof content !== "string" || !content.trim()) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getToolError(parsed: any): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const error = pickString(parsed.error);
  if (error) return error;
  const message = pickString(parsed.message);
  if (message && (parsed.ok === false || parsed.success === false || parsed.status === "error")) {
    return message;
  }
  if (parsed.ok === false) return "tool returned ok=false";
  if (parsed.success === false) return "tool returned success=false";
  return null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeToolArgumentsForFailureSignature(rawArguments: unknown): string {
  if (typeof rawArguments !== "string") return stableStringify(rawArguments ?? null);
  const trimmed = rawArguments.trim();
  if (!trimmed) return "";
  try {
    return stableStringify(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

export function recordConsecutiveToolFailure(
  guard: ToolFailureGuardState,
  toolCall: ToolFailureGuardToolCall,
  toolResult: string,
  maxConsecutiveFailures = 3,
): string | null {
  const parsed = parseToolResult(toolResult);
  const error = getToolError(parsed);
  if (!error) {
    guard.signature = null;
    guard.count = 0;
    return null;
  }

  const toolName = canonicalizeToolName(toolCall.function.name);
  const signature = stableStringify({
    toolName,
    arguments: normalizeToolArgumentsForFailureSignature(toolCall.function.arguments),
    error,
  });
  if (signature === guard.signature) {
    guard.count += 1;
  } else {
    guard.signature = signature;
    guard.count = 1;
  }

  if (guard.count < maxConsecutiveFailures) return null;

  return [
    `已停止工具循环：${toolName} 使用同一组参数连续 ${guard.count} 次返回同一个错误。`,
    `错误：${error}`,
    "请先调整参数、换一种操作路径，或向用户确认后再继续；不要继续重复同一个失败调用。",
  ].join("\n");
}
