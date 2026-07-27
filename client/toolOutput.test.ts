import { beforeEach, describe, expect, test } from "bun:test";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { getCliLocale, setCliLocale } from "../tui/i18n";
import {
  createSseToolEventAdapter,
  createToolEventFormatter,
  formatActiveToolLabel,
  formatToolEventForCli,
  clipPathAware,
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

  test("compact mode emits formatted tree for completed read tool", () => {
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
    format(
      toolEvent({
        type: "tool-result",
        toolName: "readFile",
        argumentsPreview: "README.md",
        elapsedMs: 3,
        summary: "64 lines 1630 chars tail=\"...\"",
      })
    );
    const res = format.flush ? format.flush() : "";
    expect(res).toContain("Read");
    expect(res).toContain("README.md");
    expect(res).toContain("└──");
  });

  test("compact mode drops elapsed time and generic output size from successful lines", () => {
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
    // No metadata → no read-range hint; stays the plain compact line.
    expect(line).toBe("• Read (1)\n  └── README.md\n");
    expect(line).not.toContain("ms");
  });

  test("compact mode shows readFile read range when the file was sliced", () => {
    // Full read (not truncated, 1..N/N) — no range hint, would be noise.
    expect(
      formatToolEventForCli(
        toolEvent({
          type: "tool-result",
          toolName: "readFile",
          argumentsPreview: "small.ts",
          metadata: { startLine: 1, endLine: 40, totalLines: 40, truncated: false },
        }),
        "compact",
        false
      )
    ).toBe("• Read (1)\n  └── small.ts\n");

    // Sliced read — show the range so the user can spot disjoint paging.
    expect(
      formatToolEventForCli(
        toolEvent({
          type: "tool-result",
          toolName: "readFile",
          argumentsPreview: "big.ts",
          metadata: { startLine: 1000, endLine: 1300, totalLines: 2560, truncated: true },
        }),
        "compact",
        false
      )
    ).toBe("• Read (1)\n  └── big.ts:1000-1300\n");
  });
  test("compact mode groups consecutive read events into tree view matching spec", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "c1", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49" }));
    format(toolEvent({ type: "tool-result", toolCallId: "c1", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49" }));
    format(toolEvent({ type: "tool-call", toolCallId: "c2", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/sessionTypes.ts" }));
    format(toolEvent({ type: "tool-result", toolCallId: "c2", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/sessionTypes.ts" }));
    format(toolEvent({ type: "tool-call", toolCallId: "c3", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/sessionRender.ts" }));
    format(toolEvent({ type: "tool-result", toolCallId: "c3", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/sessionRender.ts" }));
    format(toolEvent({ type: "tool-call", toolCallId: "c4", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/readlineWorkspace.ts:203-387,627-1679" }));
    format(toolEvent({ type: "tool-result", toolCallId: "c4", toolName: "readFile", argumentsPreview: "~/bun-nolo/packages/cli/tui/readlineWorkspace.ts:203-387,627-1679" }));

    const out = format.flush ? format.flush() : "";
    expect(out).toBe(
      "• Read (4)\n" +
      "  ├── ~/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49\n" +
      "  ├── ~/bun-nolo/packages/cli/tui/sessionTypes.ts\n" +
      "  ├── ~/bun-nolo/packages/cli/tui/sessionRender.ts\n" +
      "  └── ~/bun-nolo/packages/cli/tui/readlineWorkspace.ts:203-387,627-1679\n"
    );
  });
  test("compact mode groups consecutive search events into tree view matching spec", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "s1", toolName: "searchFiles", argumentsPreview: "selectionStart|selectionEnd|setSelectionRange|cursor|caret" }));
    format(toolEvent({ type: "tool-result", toolCallId: "s1", toolName: "searchFiles", argumentsPreview: "selectionStart|selectionEnd|setSelectionRange|cursor|caret" }));
    format(toolEvent({ type: "tool-call", toolCallId: "s2", toolName: "searchFiles", argumentsPreview: "contenteditable|textarea|onInput|onChange.*content|editor|Editor" }));
    format(toolEvent({ type: "tool-result", toolCallId: "s2", toolName: "searchFiles", argumentsPreview: "contenteditable|textarea|onInput|onChange.*content|editor|Editor" }));

    const out = format.flush ? format.flush() : "";
    expect(out).toBe(
      "• Search (2)\n" +
      "  ├── selectionStart|selectionEnd|setSelectionRange|cursor|caret\n" +
      "  └── contenteditable|textarea|onInput|onChange.*content|editor|Editor\n"
    );
  });

  test("compact mode shows editFile added/removed snippets", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "editFile",
        argumentsPreview: "app.ts",
        metadata: {
          path: "app.ts",
          replacements: 1,
          oldSnippet: "const a = 1;",
          newSnippet: "const a = 2;",
        },
      }),
      "compact",
      false
    );
    expect(line).toContain("▸ Edit app.ts  ✓");
    expect(line).toContain("- const a = 1;");
    expect(line).toContain("+ const a = 2;");
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
      ).toBe("• Search (1)\n  └── packages/cli\n");
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

  test("compact mode renders ui_ask_choice as a question + numbered choices", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ui_ask_choice",
        content: JSON.stringify({
          type: "ui_ask_choice",
          question: "接下来你希望我帮你做哪件事？",
          choices: [
            { id: "a", label: "生成本周周报", userMessage: "帮我生成本周周报" },
            { id: "b", label: "整理待办事项", userMessage: "帮我整理待办事项" },
          ],
          blocking: true,
        }),
        metadata: { uiAskChoice: true },
      }),
      "compact",
      false
    );
    // Should NOT be the generic compact trace line.
    expect(line).not.toContain("✓");
    // Should render the question and numbered options.
    expect(line).toContain("接下来你希望我帮你做哪件事？");
    expect(line).toContain("1. 生成本周周报");
    expect(line).toContain("2. 整理待办事项");
  });

  test("verbose mode renders ui_ask_choice question + numbered choices", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ui_ask_choice",
        content: JSON.stringify({
          type: "ui_ask_choice",
          question: "Which plan?",
          choices: [{ id: "x", label: "Plan A" }, { id: "y", label: "Plan B" }],
          blocking: true,
        }),
        metadata: { uiAskChoice: true },
      }),
      "verbose",
      false
    );
    expect(line).toContain("[nolo:tool]");
    expect(line).toContain("Which plan?");
    expect(line).toContain("1. Plan A");
    expect(line).toContain("2. Plan B");
  });

  test("compact mode falls back to generic line when ui_ask_choice content is missing", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ui_ask_choice",
        content: "",
        metadata: { uiAskChoice: true },
      }),
      "compact",
      false
    );
    // No parseable content → falls through to the generic compact trace.
    expect(line).toContain("✓");
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

  test("createSseToolEventAdapter maps SSE tool payloads to LocalAgentToolEvent", () => {
    const events: LocalAgentToolEvent[] = [];
    const adapter = createSseToolEventAdapter((evt) => events.push(evt));

    // tool_start with calls
    adapter.onToolStart(["readFile"]);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "sse-call-1",
      toolName: "readFile",
      round: 0,
    });

    // tool_result with content truncation (<= 120 chars) and metadata passthrough
    const longContent = "a".repeat(150);
    const resultEvt = adapter.onToolResult({
      toolName: "readFile",
      content: longContent,
      metadata: { ok: true },
    });
    expect(resultEvt.type).toBe("tool-result");
    expect(resultEvt.summary?.length).toBeLessThanOrEqual(120);
    expect(resultEvt.summary?.endsWith("…")).toBe(true);
    expect(resultEvt.metadata).toEqual({ ok: true });
    expect(resultEvt.round).toBe(0);

    // tool_end increments round
    adapter.onToolEnd();

    adapter.onToolStart(["execShell"]);
    expect(events[events.length - 1]).toEqual({
      type: "tool-call",
      toolCallId: "sse-call-2",
      toolName: "execShell",
      round: 1,
    });
  });

  test("formatEditDetailLine plain text output (colorEnabled=false) contains no escape codes", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "editFile",
        argumentsPreview: "file.ts",
        metadata: {
          oldSnippet: "const oldVal = 1;",
          newSnippet: "const newVal = 2;",
        },
      }),
      "compact",
      false
    );
    expect(line).toContain("- const oldVal = 1;");
    expect(line).toContain("+ const newVal = 2;");
    expect(line).not.toContain("\x1b");
  });

  test("clipPathAware elides the middle of a long path, keeping leading dirs and the filename", () => {
    // > 72 chars: a deep path whose tail (filename) is the most identifying part.
    const longPath =
      "packages/cli/tui/readlineWorkspacePromptBuffer/module/deepNest/readlineWorkspace.ts";
    const out = clipPathAware(longPath);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out).toContain("…");
    // Full filename survives — that is the whole point of eliding the middle.
    expect(out.endsWith("readlineWorkspace.ts")).toBe(true);
    // More than the first segment survives when the budget allows it. Keeping
    // only "packages/…" would be nearly useless in a monorepo where every path
    // starts with the same top-level directory.
    expect(out.startsWith("packages/cli/tui/")).toBe(true);
  });

  test("clipPathAware keeps the leading slash of an absolute path", () => {
    // An absolute path splits into an empty first segment. Accumulator-style
    // prefix building treats that empty string as falsy and drops the leading
    // "/", rendering an absolute path as a relative-looking one.
    const absolute =
      "/Users/nolotus/bun-nolo/packages/cli/tui/deeply/nested/readlineWorkspace.ts";
    const out = clipPathAware(absolute);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out).toContain("…");
    expect(out.startsWith("/Users/nolotus/")).toBe(true);
    expect(out.endsWith("readlineWorkspace.ts")).toBe(true);
  });

  test("clipPathAware drops leading dirs that do not fit the budget", () => {
    // Deep enough that the greedy prefix cannot keep every leading segment.
    const deeper =
      "packages/agent-runtime/deeply/nested/module/tree/with/many/levels/localWorkspaceToolExecutors.ts";
    const out = clipPathAware(deeper);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("localWorkspaceToolExecutors.ts")).toBe(true);
    expect(out.startsWith("packages/agent-runtime/")).toBe(true);
    // The segments that did not fit are gone, replaced by the elision.
    expect(out).toContain("…");
    expect(out).not.toContain("/levels/");
  });

  test("clipPathAware leaves a short path untouched", () => {
    const shortPath = "packages/cli/tui/theme.ts";
    const out = clipPathAware(shortPath);
    expect(out).toBe(shortPath);
    expect(out).not.toContain("…");
  });

  test("clipPathAware falls back to tail clip for non-path (spaced) values", () => {
    // Contains a space → not a path → shared tail clip, ends with ellipsis.
    // Must exceed max (72) so clipping actually triggers.
    const cmd = "bun test packages/cli/tui packages/cli/client --filter some-very-long-tag-name-that-pushes-past-limit-xyz";
    expect(cmd.length).toBeGreaterThan(72);
    const out = clipPathAware(cmd);
    expect(out.endsWith("…")).toBe(true);
    // Should not be a middle elision (no "/…/" pattern).
    expect(out).not.toContain("/…/");
  });

  test("clipPathAware falls back to tail clip when the filename alone meets the budget", () => {
    // A single segment (no slash) is not a path; a single-segment filename
    // that itself exceeds max must fall back to the shared tail clip.
    const hugeFile = "x".repeat(100);
    const out = clipPathAware(hugeFile);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(72);
  });

  test("formatToolEventForCli shows the full filename for a long-path readFile event with color disabled", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "readFile",
        argumentsPreview:
          "packages/agent-runtime/deeply/nested/module/tree/with/many/levels/localWorkspaceToolExecutors.ts",
        summary: "64 lines 1630 chars",
      }),
      "compact",
      false
    );
    // The full filename must be visible even though the path was clipped.
    expect(line).toContain("localWorkspaceToolExecutors.ts");
    expect(line).toContain("…");
    // The segments that did not fit the budget are elided away.
    expect(line).not.toContain("/levels/");
  });
});
