/**
 * Parse `\u003cthink\u003e...\u003c/think\u003e` blocks that some models (MiniMax M3, etc.)
 * emit inside the ordinary `content` field instead of a separate
 * `reasoning_content` / `reasoning` delta.
 *
 * The helpers support both complete-string extraction and streaming
 * chunk-by-chunk parsing with partial-tag buffering.
 */

export type ThinkParseState = {
  mode: "content" | "reasoning";
  /** unprocessed tail kept to detect tags split across chunks */
  buffer: string;
  /** true when the next visible content emission follows a \u003c/think\u003e boundary */
  trimNextVisible: boolean;
};

const OPEN_TAG = "\u003cthink\u003e";
const CLOSE_TAG = "\u003c/think\u003e";

/**
 * Returns the length of the longest suffix of `buffer` that is also a
 * prefix of `tag`. Used to keep only the bytes that could complete a tag
 * when a chunk ends mid-tag.
 */
function longestTagPrefixLength(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(buffer.slice(-len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Extract thinking blocks from a complete response string.
 * Returns the visible content and, if any `\u003cthink\u003e` block existed,
 * the collected reasoning text.
 */
export function extractThinkContent(content: string): {
  content: string;
  reasoning?: string;
} {
  const regex = new RegExp(`${OPEN_TAG}([\\s\\S]*?)${CLOSE_TAG}`, "g");
  const matches = [...content.matchAll(regex)];
  if (matches.length === 0) {
    return { content };
  }
  const reasoning = matches.map((m) => m[1]).join("\n");
  const cleaned = content.replace(regex, "");
  return { content: cleaned.replace(/^\n/, ""), reasoning };
}

export function createThinkParserState(): ThinkParseState {
  return { mode: "content", buffer: "", trimNextVisible: false };
}

/**
 * Process one streaming chunk, splitting visible content from reasoning
 * content whenever `\u003cthink\u003e` / `\u003c/think\u003e` boundaries appear.
 *
 * Handles chunk boundaries by keeping only the smallest suffix that could
 * still complete an opening or closing tag.
 */
export function processThinkChunk(
  chunk: string,
  state: ThinkParseState,
): {
  content: string;
  reasoning: string;
  state: ThinkParseState;
} {
  let visible = "";
  let reasoning = "";
  let { mode, buffer, trimNextVisible } = state;
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
      mode = "reasoning";
    } else {
      const idx = buffer.indexOf(CLOSE_TAG);
      if (idx === -1) {
        const keep = longestTagPrefixLength(buffer, CLOSE_TAG);
        reasoning += buffer.slice(0, buffer.length - keep);
        buffer = buffer.slice(buffer.length - keep);
        break;
      }
      reasoning += buffer.slice(0, idx);
      buffer = buffer.slice(idx + CLOSE_TAG.length);
      mode = "content";
      trimNextVisible = true;
    }
  }

  if (mode === "content" && visible.length > 0 && trimNextVisible) {
    visible = visible.replace(/^\n/, "");
    trimNextVisible = false;
  }

  return { content: visible, reasoning, state: { mode, buffer, trimNextVisible } };
}

/**
 * Flush any remaining buffered bytes at the end of a stream.
 */
export function flushThinkParser(state: ThinkParseState): {
  content: string;
  reasoning: string;
  state: ThinkParseState;
} {
  const { mode, buffer, trimNextVisible } = state;
  if (mode === "reasoning") {
    return {
      content: "",
      reasoning: buffer,
      state: { mode: "content", buffer: "", trimNextVisible: false },
    };
  }
  let visible = buffer;
  const nextTrim = trimNextVisible;
  if (nextTrim) {
    visible = visible.replace(/^\n/, "");
  }
  return {
    content: visible,
    reasoning: "",
    state: { mode: "content", buffer: "", trimNextVisible: false },
  };
}
