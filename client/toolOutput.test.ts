import { describe, expect, test } from "bun:test";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import {
  createToolEventFormatter,
  formatToolEventForCli,
  normalizeToolDisplayMode,
  resolveToolDisplayMode,
  shouldEmitToolEvents,
} from "./toolOutput";

function toolEvent(
  partial: Partial<LocalAgentToolEvent> & Pick<LocalAgentToolEvent, "type" | "toolName">
): LocalAgentToolEvent {
  return {
    round: 0,
    toolCallId: "call-1",
    ...partial,
  };
}

describe("toolOutput", () => {
  test("defaults to compact and respects legacy NOLO_TRACE_TOOLS hide", () => {
    expect(normalizeToolDisplayMode(undefined)).toBe("compact");
    expect(resolveToolDisplayMode({ NOLO_TRACE_TOOLS: "0" })).toBe("hide");
    expect(resolveToolDisplayMode({ NOLO_TRACE_TOOLS: "verbose" })).toBe("verbose");
    expect(shouldEmitToolEvents("compact")).toBe(true);
    expect(shouldEmitToolEvents("hide")).toBe(false);
  });

  test("compact mode emits one line per completed tool", () => {
    const format = createToolEventFormatter("compact");
    expect(
      format(
        toolEvent({
          type: "tool-call",
          toolName: "readFile",
          argumentsPreview: "README.md",
        })
      )
    ).toBe("");
    expect(
      format(
        toolEvent({
          type: "tool-result",
          toolName: "readFile",
          argumentsPreview: "README.md",
          elapsedMs: 3,
          summary: "64 lines 1630 chars tail=\"...\"",
        })
      )
    ).toContain("readFile README.md");
    expect(
      format(
        toolEvent({
          type: "tool-result",
          toolName: "readFile",
          argumentsPreview: "README.md",
          elapsedMs: 3,
          summary: "64 lines 1630 chars tail=\"...\"",
        })
      )
    ).toContain("✓");
  });

  test("verbose mode keeps legacy trace format", () => {
    expect(
      formatToolEventForCli(
        toolEvent({
          type: "tool-call",
          toolName: "readFile",
          argumentsPreview: "README.md",
        }),
        "verbose"
      )
    ).toBe("[nolo:tool] #1 -> readFile README.md\n");
  });
});