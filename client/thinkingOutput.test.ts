import { describe, expect, test } from "bun:test";

import {
  collapseThinkingBlocks,
  createThinkingAwareStreamFilter,
  createThinkingEventSink,
  formatAssistantTextForCli,
  normalizeThinkingDisplayMode,
} from "./thinkingOutput";

describe("thinkingOutput", () => {
  test("createThinkingEventSink handles show, marker, and hide modes", () => {
    // show mode: emits all chunks as-is
    const showChunks: string[] = [];
    const showSink = createThinkingEventSink("show", (chunk) => showChunks.push(chunk));
    showSink.push("thinking ");
    showSink.push("process...");
    expect(showChunks.join("")).toBe("thinking process...");

    // marker mode: emits fold marker once on first non-empty chunk
    const markerChunks: string[] = [];
    const markerSink = createThinkingEventSink("marker", (chunk) => markerChunks.push(chunk));
    markerSink.push("");
    markerSink.push("first chunk");
    markerSink.push("second chunk");
    expect(markerChunks).toEqual(["\n▸ 思考已折叠\n"]);

    // hide mode: drops all chunks
    const hideChunks: string[] = [];
    const hideSink = createThinkingEventSink("hide", (chunk) => hideChunks.push(chunk));
    hideSink.push("hidden thinking");
    expect(hideChunks).toEqual([]);
  });
  test("defaults to hide mode", () => {
    expect(normalizeThinkingDisplayMode(undefined)).toBe("hide");
    expect(formatAssistantTextForCli("你好\n<think>secret</think>\n结束", "hide")).toBe(
      "你好\n结束"
    );
  });

  test("strips server-side collapsed markers in hide mode", () => {
    expect(
      formatAssistantTextForCli("前缀\n▸ 思考已折叠\n\n后缀", "hide")
    ).toBe("前缀\n后缀");
  });

  test("shows marker mode text", () => {
    expect(collapseThinkingBlocks("<think>secret</think>\n答案", "marker")).toContain(
      "▸ 思考已折叠"
    );
  });

  test("streams visible text while hiding think blocks", () => {
    const chunks: string[] = [];
    const filter = createThinkingAwareStreamFilter((chunk) => chunks.push(chunk), "hide");

    filter.push("前缀");
    filter.push("<think>");
    filter.push("secret");
    filter.push("</think>");
    filter.push("\n▸ 思考已折叠\n");
    filter.push("后缀");
    filter.flush();

    expect(chunks.join("")).toBe("前缀\n后缀");
  });
});