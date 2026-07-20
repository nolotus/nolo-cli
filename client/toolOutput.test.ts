import { beforeEach, describe, expect, test } from "bun:test";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { getCliLocale, setCliLocale } from "../tui/i18n";
import {
  createToolEventFormatter,
  formatActiveToolLabel,
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
  // Tool labels and status hints are localized, so the trace assertions below
  // would otherwise depend on the machine's LANG. Pin to en for the shared
  // cases; the locale-specific test flips it explicitly.
  beforeEach(() => {
    setCliLocale("en");
  });

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
    ).toContain("Read README.md");
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

  test("compact mode drops elapsed time and output size from successful lines", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "readFile",
        argumentsPreview: "README.md",
        elapsedMs: 3,
        summary: "64 lines 1630 chars tail=\"...\"",
      }),
      "compact",
      false
    );
    expect(line).toBe("  ▸ Read README.md  ✓\n");
    expect(line).not.toContain("ms");
    expect(line).not.toContain("lines");
  });

  test("compact labels follow the active locale, unknown tools keep their raw name", () => {
    const previous = getCliLocale();
    try {
      setCliLocale("zh");
      expect(
        formatToolEventForCli(
          toolEvent({
            type: "tool-result",
            toolName: "searchFiles",
            argumentsPreview: "packages/cli",
            elapsedMs: 27,
          }),
          "compact",
          false
        )
      ).toBe("  ▸ 搜索 packages/cli  ✓\n");
      // Not in the label table (platform tool registry) — fall back verbatim.
      expect(formatActiveToolLabel({ toolName: "ziweiChart" })).toBe("ziweiChart");
    } finally {
      setCliLocale(previous);
    }
  });

  test("formats a clipped label for an in-flight compact tool", () => {
    expect(
      formatActiveToolLabel({
        toolName: "execShell",
        argumentsPreview: "bun test tui/session.test.ts",
      })
    ).toBe("Run bun test tui/session.test.ts");
    expect(
      formatActiveToolLabel({
        toolName: "execShell",
        argumentsPreview: "x".repeat(100),
      })
    ).toBe(`Run ${"x".repeat(71)}…`);
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
    ).toContain("✗ timed out");
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
            actionGate: {
              id: "gate-test",
              kind: "handoff",
              title: "This command requires an interactive terminal.",
              payload: {
                command: ["gh", "auth", "refresh", "-h", "github.com", "-s", "delete_repo"],
                displayCommand: "gh auth refresh -h github.com -s delete_repo",
              },
            },
          },
        }),
        "compact",
        false
      )
    ).toContain("! needs action: gh auth refresh -h github.com -s delete_repo");
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
