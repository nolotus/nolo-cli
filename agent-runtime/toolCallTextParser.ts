/**
 * Strip Qwen3-style tool-call text markers from streaming content/reasoning.
 *
 * When enable_thinking is on and Qwen3 decides to call a tool, some
 * DashScope / vLLM streaming responses emit the tool call as inline text
 * markers in delta.content instead of structured delta.tool_calls.
 * (The markers may also appear in delta.reasoning, but this parser
 * currently only strips them from content — reasoning passes through.) The markers are XML-like tags wrapping a JSON object.
 * Without stripping, the tag text leaks into visible content (the user sees
 * repeated "call" fragments from the tag name), producing the "call call call"
 * symptom.
 *
 * This parser mirrors thinkTagParser streaming approach: it detects the
 * opening and closing tags, buffers across chunk boundaries, and returns the
 * cleaned visible content plus the extracted tool-call JSON for optional
 * structured conversion.
 *
 * The tags are XML-like OPEN/CLOSE constants defined below.
 */

import { longestTagPrefixLength } from "./tagPrefixMatch";

export type ToolCallTextParseState = {
  mode: "content" | "toolcall";
  /** unprocessed tail kept to detect tags split across chunks */
  buffer: string;
};

export type ProcessedToolCallTextChunk = {
  content: string;
  /** raw text extracted from inside each tool-call tag (JSON strings, one per block) */
  toolCallTexts: string[];
  state: ToolCallTextParseState;
};

const OPEN_TAG = "<" + "tool_call" + ">";
const CLOSE_TAG = "<" + "/tool_call" + ">";

export function createToolCallTextParserState(): ToolCallTextParseState {
  return { mode: "content", buffer: "" };
}

/**
 * Process one streaming chunk, stripping tool-call markers from visible
 * content and collecting the text inside the tags.
 *
 * Handles chunk boundaries by keeping only the smallest suffix that could
 * still complete an opening or closing tag.
 */
export function processToolCallTextChunk(
  chunk: string,
  state: ToolCallTextParseState,
): ProcessedToolCallTextChunk {
  let visible = "";
  let toolCallTexts: string[] = [];
  let { mode, buffer } = state;
  buffer += chunk;

  while (true) {
    if (mode === "content") {
      const idx = buffer.indexOf(OPEN_TAG);
      if (idx === -1) {
        const keep = longestTagPrefixLength(buffer, OPEN_TAG);
        visible += buffer.slice(0, buffer.length - keep);
        buffer = buffer.slice(buffer.length - keep);
        break;
      }
      visible += buffer.slice(0, idx);
      buffer = buffer.slice(idx + OPEN_TAG.length);
      mode = "toolcall";
    } else {
      const idx = buffer.indexOf(CLOSE_TAG);
      if (idx === -1) {
        // The tool-call JSON payload can span multiple chunks. Keep
        // accumulating it in the buffer until the closing tag arrives;
        // emitting partial fragments here would fail JSON.parse downstream
        // and silently drop tool calls split across chunk boundaries.
        break;
      }
      toolCallTexts.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + CLOSE_TAG.length);
      mode = "content";
    }
  }

  return {
    content: visible,
    toolCallTexts,
    state: { mode, buffer },
  };
}

/**
 * Flush any remaining buffered bytes at the end of a stream.
 *
 * If we were inside a tool-call block, the buffered text is tool-call content
 * (not visible). If we were in content mode, the buffer is visible text that
 * may include a partial opening tag -- emit it as content since we cannot know
 * if it was meant to be a tag.
 */
export function flushToolCallTextParser(state: ToolCallTextParseState): {
  content: string;
  toolCallTexts: string[];
  state: ToolCallTextParseState;
} {
  const { mode, buffer } = state;
  if (mode === "toolcall") {
    // The stream ended before the closing tag arrived. Strip a trailing
    // partial close-tag prefix (e.g. "</tool_") so the accumulated JSON can
    // still be parsed and delivered on a best-effort basis.
    const keep = longestTagPrefixLength(buffer, CLOSE_TAG);
    const text = buffer.slice(0, buffer.length - keep);
    return {
      content: "",
      toolCallTexts: text ? [text] : [],
      state: { mode: "content", buffer: "" },
    };
  }
  return {
    content: buffer,
    toolCallTexts: [],
    state: { mode: "content", buffer: "" },
  };
}

/**
 * Try to parse a tool-call JSON string into an OpenAI-style tool call object.
 * Returns null if the JSON is invalid or incomplete.
 */
export function tryParseToolCallText(text: string): {
  name: string;
  arguments: string;
} | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.name === "string"
    ) {
      return {
        name: parsed.name,
        arguments:
          typeof parsed.arguments === "string"
            ? parsed.arguments
            : JSON.stringify(parsed.arguments ?? {}),
      };
    }
  } catch {
    // invalid JSON -- not a complete tool call
  }
  return null;
}

/**
 * Process a content chunk through the tool-call text parser, and if any
 * tool-call text was extracted, parse it and feed the result into the
 * provided callback.
 *
 * Returns the cleaned content (with tool-call markers stripped) and the
 * updated parser state. This is the single entry point for callers that
 * need to strip tool-call markers from a streaming content delta and
 * simultaneously accumulate structured tool calls.
 */
export function processContentChunkWithToolCallStripping(
  chunk: string,
  state: ToolCallTextParseState,
  onToolCall: (name: string, args: string) => void,
): { cleanedContent: string; state: ToolCallTextParseState } {
  const stripped = processToolCallTextChunk(chunk, state);
  for (const text of stripped.toolCallTexts) {
    const parsedTc = tryParseToolCallText(text);
    if (parsedTc) {
      onToolCall(parsedTc.name, parsedTc.arguments);
    }
  }
  return { cleanedContent: stripped.content, state: stripped.state };
}

/**
 * Flush the tool-call text parser at end-of-stream, feeding any residual
 * tool-call text into the provided callback. Returns any residual visible
 * content and the reset parser state.
 */
export function flushToolCallTextParserIntoCallback(
  state: ToolCallTextParseState,
  onToolCall: (name: string, args: string) => void,
): { residualContent: string; state: ToolCallTextParseState } {
  const flushed = flushToolCallTextParser(state);
  for (const text of flushed.toolCallTexts) {
    const parsedTc = tryParseToolCallText(text);
    if (parsedTc) {
      onToolCall(parsedTc.name, parsedTc.arguments);
    }
  }
  return { residualContent: flushed.content, state: flushed.state };
}
