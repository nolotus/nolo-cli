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

  test("compact mode marks shell result with non-zero exit code as failed", () => {
    expect(
      formatToolEventForCli(
        toolEvent({
          type: "tool-result",
          toolName: "execShell",
          argumentsPreview: "gh auth refresh -s delete_repo",
          elapsedMs: 30000,
          summary: "exit=124 3 lines 80 chars tail=\"command timed out after 30000ms exitCode: 124\"",
          metadata: { exitCode: 124, timedOut: true },
        }),
        "compact",
        false
      )
    ).toContain("✗ 30000ms · timed out");
  });

  test("compact mode shows interactive command recovery hint", () => {
    expect(
      formatToolEventForCli(
        toolEvent({
          type: "tool-result",
          toolName: "execShell",
          argumentsPreview: "gh auth refresh -s delete_repo",
          elapsedMs: 2,
          summary: "exit=130 5 lines 200 chars",
          metadata: {
            exitCode: 130,
            requiresUserAction: {
              type: "terminal_command",
              argv: ["gh", "auth", "refresh", "-h", "github.com", "-s", "delete_repo"],
              displayCommand: "gh auth refresh -h github.com -s delete_repo",
            },
          },
        }),
        "compact",
        false
      )
    ).toContain("✗ 2ms · needs terminal: gh auth refresh -h github.com -s delete_repo");
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
