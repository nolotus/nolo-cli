/**
 * Outbound history sanitization for cross-wire / cross-provider replay.
 *
 * When a dialog is replayed to a provider via `/switch` (or any continuation
 * after a model/provider change), the neutral history may contain
 * `tool_calls`, `tool` results, and `reasoning_content` produced by a *prior*
 * model. Different provider gateways validate this inbound history with
 * different strictness — ollama, for example, rejects:
 *   - tool_calls whose name is not in the current `tools` array (400),
 *   - assistant tool_calls without a matching `tool` result (mismatch 400),
 *   - orphan `tool` results with no preceding tool_call (400),
 *   - non-string `arguments` on some clients.
 *
 * This module is the single seam that cleans neutral history into a shape the
 * target provider will accept, BEFORE the wire adapter turns it into the
 * provider-specific request body. It is a pure function (no IO) so it can be
 * unit-tested directly and shared by the CLI local runtime and the web
 * wireAdapters.
 *
 * Principles:
 *   - Idempotent: sanitize(sanitize(x)) === sanitize(x). Repeated replay must
 *     not accumulate rewrites.
 *   - Non-destructive when nothing needs cleaning: pass through unchanged.
 *   - Downgrade, never drop: a tool_call that can't be replayed structurally is
 *     rendered as readable text so the next model still sees the intent and
 *     can re-issue the call itself.
 */
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeToolCall,
} from "./types";
import { extractDeclaredToolNames } from "./declaredToolNames";

export interface OutboundHistorySanitizeOptions {
  /**
   * Tool names declared in the *current* request's `tools` array. A history
   * tool_call whose `function.name` is not in this set is downgraded to text
   * rather than sent structurally (some gateways reject unknown tool names on
   * inbound history with 400). When undefined (caller has no tools concept),
   * no tool-name filtering is done. An EMPTY Set means "no tools declared this
   * turn" → all history tool_calls downgrade.
   */
  declaredToolNames?: Set<string>;
}

/**
 * Convenience wrapper: sanitize history for outbound replay, deriving the
 * declared-tool-name set from the current request's `tools` array in one call.
 * This is the shape every outbound seam wants — `sanitizeForOutbound(messages,
 * tools)` — so the three call sites don't each repeat the
 * `extractDeclaredToolNames(tools)` + `sanitize(messages, {declaredToolNames})`
 * pair.
 */
export function sanitizeForOutbound(
  messages: AgentRuntimeChatMessage[],
  tools?: unknown[],
): AgentRuntimeChatMessage[] {
  return sanitizeOutboundHistory(messages, {
    declaredToolNames: extractDeclaredToolNames(tools),
  });
}

/**
 * Stable id minted to repair a tool_call missing an id, so its tool result can
 * still be paired. Deterministic per (assistantIndex, callIndex) so a second
 * sanitize pass produces the same id (idempotency).
 */
function stableToolCallId(assistantIndex: number, callIndex: number): string {
  return `call_sanitize_${assistantIndex}_${callIndex}`;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Join non-empty string fragments with newlines (skips empty/undefined). */
function joinLines(...parts: (string | undefined)[]): string {
  return parts.filter(isNonEmptyString).join("\n");
}

function jsonStringifyArguments(args: unknown): string {
  // Already a string: keep as-is, even if it is not valid JSON — rewriting a
  // malformed string would silently change semantics. The target provider's
  // own validation will surface it, which is the honest failure mode.
  if (typeof args === "string") return args;
  // Object/array: stringify for providers that expect a string arguments field
  // (the OpenAI Chat Completions spec). Fails safe to "" for null/undefined.
  try {
    return JSON.stringify(args ?? "");
  } catch {
    return "";
  }
}

/**
 * Render a tool_call as readable text so the next model can still see the
 * intent after a structural downgrade. Always produces a string arguments
 * representation (object args would otherwise render as `[object Object]`).
 */
function renderToolCallAsText(call: AgentRuntimeToolCall): string {
  const name = call?.function?.name ?? "unknown";
  const rawArgs = call?.function?.arguments;
  const args = jsonStringifyArguments(rawArgs);
  return `[tool_call: ${name}(${args})]`;
}

function renderToolResultAsText(message: AgentRuntimeChatMessage): string {
  const name = isNonEmptyString(message.toolName) ? message.toolName : "tool";
  const body = typeof message.content === "string" ? message.content : "";
  return `[tool_result: ${name}: ${body}]`;
}

/**
 * Normalize a single tool_call: ensure id, string arguments, type=function.
 * Returns null if the call is too malformed to keep.
 */
function normalizeToolCall(
  call: unknown,
  assistantIndex: number,
  callIndex: number,
): AgentRuntimeToolCall | null {
  if (!call || typeof call !== "object") return null;
  const c = call as Record<string, any>;
  const fn = c.function;
  if (!fn || typeof fn !== "object" || !isString(fn.name)) return null;
  const id = isNonEmptyString(c.id) ? c.id : stableToolCallId(assistantIndex, callIndex);
  return {
    id,
    type: isString(c.type) && c.type ? (c.type as "function") : "function",
    function: { name: fn.name, arguments: jsonStringifyArguments(fn.arguments) },
    ...(typeof c.thought_signature === "string"
      ? { thought_signature: c.thought_signature }
      : {}),
  };
}

/**
 * Sanitize neutral history for outbound replay to a target provider.
 *
 * See module doc for the cleaning rules and design principles.
 */
export function sanitizeOutboundHistory(
  messages: AgentRuntimeChatMessage[],
  options?: OutboundHistorySanitizeOptions,
): AgentRuntimeChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // NOTE: reasoning_content stripping is deliberately NOT done here. It is a
  // wire-specific concern (DeepSeek completions rejects string
  // reasoning_content on replay; Responses wire converts it to array content
  // parts). Each wire converter (toOpenAiCompatibleMessages /
  // convertMessagesToResponsesInput) already applies the right policy per
  // target. Sanitize only fixes cross-provider tool_call / tool-result shape
  // issues that gateways reject before the body even reaches the model.
  const declared = options?.declaredToolNames;

  // First pass: collect the set of tool_call ids we MIGHT keep structurally
  // (those whose name is declared, or all if no declaredToolNames filter).
  const candidateCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    m.tool_calls.forEach((call, callIndex) => {
      const name = call?.function?.name;
      const declaredAllows = !declared || (isString(name) && declared.has(name));
      if (!declaredAllows) return; // will be downgraded, don't pair its result
      const id = isNonEmptyString(call?.id)
        ? call.id
        : stableToolCallId(i, callIndex);
      candidateCallIds.add(id);
    });
  }

  // Second pass: a candidate is only KEPT structurally if it has a matching
  // tool result in the history. A structural tool_call with no result would
  // leave a dangling call that gateways like ollama reject with
  // "mismatch between tool calls and tool results" (400). Downgrade instead.
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && isNonEmptyString(m.tool_call_id)) {
      resultIds.add(m.tool_call_id);
    }
  }
  const keepCallIds = new Set<string>();
  for (const id of candidateCallIds) {
    if (resultIds.has(id)) keepCallIds.add(id);
  }
  // Set relationship: keepCallIds = candidateCallIds ∩ resultIds.
  // candidateCallIds = tool_calls that passed the declared-name filter.
  // resultIds = tool messages with a non-empty tool_call_id.
  // A tool_call is kept structurally only if it is both declared AND has a
  // matching tool result; everything else (undeclared or dangling) is
  // downgraded to text in the loop below.

  const out: AgentRuntimeChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "assistant") {
      let toolCalls: AgentRuntimeToolCall[] | undefined;
      const downgradedLines: string[] = [];

      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const kept: AgentRuntimeToolCall[] = [];
        m.tool_calls.forEach((call, callIndex) => {
          const name = call?.function?.name;
          const declaredAllows =
            !declared || (isString(name) && declared.has(name));
          const id = isNonEmptyString(call?.id)
            ? call.id
            : stableToolCallId(i, callIndex);
          // Keep structurally only if declared AND has a matching tool result
          // (dangling calls without results get downgraded to text to avoid
          // gateway "mismatch between tool calls and tool results" 400).
          const keepStructural = declaredAllows && keepCallIds.has(id);
          if (keepStructural) {
            const normalized = normalizeToolCall(call, i, callIndex);
            if (normalized) kept.push(normalized);
          } else {
            // Downgrade (undeclared name OR dangling with no result) to text.
            downgradedLines.push(renderToolCallAsText(call as AgentRuntimeToolCall));
          }
        });
        toolCalls = kept.length > 0 ? kept : undefined;
      }

      const downgradedText = joinLines(...downgradedLines);
      const contentWithDowngrade =
        downgradedText.length > 0
          ? combineContentWithText(m.content, downgradedText)
          : m.content;

      // Spread the source first so future-added neutral fields survive, then
      // override content and tool_calls. tool_calls must be EXPLICITLY set
      // (undefined when fully downgraded) — a conditional spread would leave
      // the source's original tool_calls in place via the `...m` spread.
      const sanitizedAssistant: AgentRuntimeChatMessage = {
        ...m,
        content: contentWithDowngrade,
        tool_calls: toolCalls,
      };
      // Drop tool_calls entirely when none survived (undefined would still
      // serialize as a present-but-undefined field on some transports).
      if (!toolCalls) delete sanitizedAssistant.tool_calls;
      out.push(sanitizedAssistant);
      continue;
    }

    if (m.role === "tool") {
      const id = isNonEmptyString(m.tool_call_id) ? m.tool_call_id : "";
      // Keep the tool result structurally only if it pairs with a kept tool_call.
      if (id && keepCallIds.has(id)) {
        out.push({ ...m, content: m.content ?? "", tool_call_id: id });
      } else {
        // Orphan tool result (no matching kept tool_call) → downgrade to text.
        out.push({
          role: "assistant",
          content: renderToolResultAsText(m),
        });
      }
      continue;
    }

    // user / system / other: pass through unchanged.
    out.push({ ...m });
  }

  return out;
}

function combineContentWithText(
  base: AgentRuntimeChatMessage["content"],
  extra: string,
): AgentRuntimeChatMessage["content"] {
  if (typeof base === "string") {
    return base ? `${base}\n${extra}` : extra;
  }
  if (Array.isArray(base)) {
    return [...base, { type: "text", text: extra }];
  }
  return extra;
}