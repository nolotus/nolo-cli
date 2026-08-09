import { beforeEach, describe, expect, test } from "bun:test";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { getCliLocale, setCliLocale } from "../tui/i18n";
import { displayWidth } from "../tui/tuiAnsi";
import {
  createSseToolEventAdapter,
  createToolEventFormatter,
  formatActiveToolLabel,
  formatFetchTreeBlockForCli,
  formatReadTreeBlockForCli,
  formatRunTreeBlockForCli,
  formatSearchTreeBlockForCli,
  formatToolEventForCli,
  clipPathAware,
  normalizeToolDisplayMode,
  resolveToolDisplayMode,
  shouldEmitToolEvents,
} from "./toolOutput";

/** Strip ANSI SGR sequences so displayWidth measures the visible glyphs. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Count detail lines whose visible text starts with a given 2-char marker. */
function countDetailMarker(out: string, marker: string): number {
  return out
    .split("\n")
    .filter((l) => l.startsWith(`  ${marker}`)).length;
}

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

  test("compact mode shows editFile added/removed snippets as a real line-level diff", () => {
    // Single-line change: the old behavior would show "delete 1 / add 1"
    // wholesale, which is fine here, but the line-level diff must still emit
    // exactly one removed + one added line (no spurious context duplication).
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
    // Exactly one removed and one added line — no duplication from the old
    // whole-snippet tagging.
    expect(countDetailMarker(line, "- ")).toBe(1);
    expect(countDetailMarker(line, "+ ")).toBe(1);
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
      ).toBe("• 搜索 (1)\n  └── packages/cli\n");
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
    const line = formatToolEventForCli(
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
    );
    // Run-class results now fold into the • Run (N) tree; the leaf carries the
    // timeout inline so the failure stays visible without a standalone ✗ line.
    expect(line).toContain("• Run (1)");
    expect(line).toContain("gh auth refresh -s delete_repo");
    expect(line).toContain("(timed out)");
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

  test("compact mode renders ask_user as a question + numbered choices", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ask_user",
        content: JSON.stringify({
          type: "ask_user",
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

  test("compact mode renders a resolved ask_user as question + selected", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ask_user",
        content: JSON.stringify({
          type: "ask_user",
          question: "选哪个？",
          choices: [
            { id: "a", label: "选项 A", userMessage: "我选 A" },
            { id: "b", label: "选项 B", userMessage: "我选 B" },
          ],
          blocking: true,
          selected: { label: "选项 A", userMessage: "我选 A" },
        }),
        metadata: { uiAskChoice: true, resolved: true },
      }),
      "compact",
      false
    );
    expect(line).toContain("选哪个？");
    expect(line).toContain("选项 A");
    // Resolved history must NOT re-print the interactive menu / type-a-number hint.
    expect(line).not.toContain("1. 选项 A");
    expect(line).not.toContain("请输入序号");
    expect(line).not.toContain("Type a number");
  });

  test("compact mode keeps resolved ask_user out of the menu when selected label is empty", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ask_user",
        content: JSON.stringify({
          type: "ask_user",
          question: "选哪个？",
          choices: [
            { id: "a", label: "选项 A", userMessage: "我选 A" },
            { id: "b", label: "选项 B", userMessage: "我选 B" },
          ],
          blocking: true,
          selected: { label: "", userMessage: "" },
        }),
        metadata: { uiAskChoice: true, resolved: true },
      }),
      "compact",
      false
    );
    expect(line).toContain("选哪个？");
    expect(line).toContain("✓");
    expect(line).not.toContain("1. 选项 A");
    expect(line).not.toContain("请输入序号");
    expect(line).not.toContain("Type a number");
  });

  test("compact mode renders a cancelled ask_user without the menu", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ask_user",
        content: JSON.stringify({
          type: "ask_user",
          question: "选哪个？",
          choices: [{ id: "a", label: "选项 A" }],
          blocking: true,
          selected: { label: "", userMessage: "" },
          cancelled: true,
        }),
        metadata: { uiAskChoice: true, resolved: true, cancelled: true },
      }),
      "compact",
      false
    );
    expect(line).toContain("选哪个？");
    expect(line).not.toContain("1. 选项 A");
    expect(line).not.toContain("请输入序号");
  });

  test("verbose mode renders ask_user question + numbered choices", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ask_user",
        content: JSON.stringify({
          type: "ask_user",
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

  test("compact mode falls back to generic line when ask_user content is missing", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "ask_user",
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

  test("createSseToolEventAdapter preserves provider tool ids for unusual parallel calls", () => {
    const events: LocalAgentToolEvent[] = [];
    const adapter = createSseToolEventAdapter((evt) => events.push(evt));

    adapter.onToolStart({
      calls: [
        { toolCallId: "fc_weather_beijing", toolName: "get_weather" },
        { toolCallId: "fc_weather_shanghai", toolName: "get_weather" },
      ],
    });

    expect(events.map((event) => event.toolCallId)).toEqual([
      "fc_weather_beijing",
      "fc_weather_shanghai",
    ]);

    const secondResult = adapter.onToolResult({
      toolCallId: "fc_weather_shanghai",
      toolName: "get_weather",
      content: "Shanghai: 31C",
    });
    const firstResult = adapter.onToolResult({
      toolCallId: "fc_weather_beijing",
      toolName: "get_weather",
      content: "Beijing: 29C",
    });

    expect(secondResult.toolCallId).toBe("fc_weather_shanghai");
    expect(firstResult.toolCallId).toBe("fc_weather_beijing");
    expect(secondResult.toolName).toBe("get_weather");
    expect(firstResult.toolName).toBe("get_weather");
  });

  test("formatEditDetailBlock plain text output (colorEnabled=false) contains no escape codes", () => {
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

  test("single-char edit in a 5-line snippet shows only the changed line, not 5 del + 5 add", () => {
    // Core value of this task: a one-character change must NOT render as
    // "delete 5 lines / add 5 lines". The line-level diff keeps the 4
    // unchanged lines as context and emits exactly 1 removed + 1 added.
    const oldSnippet = ["line one", "line two", "line three", "line four", "line five"].join("\n");
    const newSnippet = ["line one", "line two", "line THREE", "line four", "line five"].join("\n");
    const out = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "editFile",
        argumentsPreview: "app.ts",
        metadata: { oldSnippet, newSnippet },
      }),
      "compact",
      false
    );
    expect(countDetailMarker(out, "- ")).toBe(1);
    expect(countDetailMarker(out, "+ ")).toBe(1);
    expect(out).toContain("- line three");
    expect(out).toContain("+ line THREE");
    // The unchanged lines survive as context (two-space prefix), proving the
    // diff is line-level rather than whole-snippet.
    expect(out).toContain("  line one");
    expect(out).toContain("  line five");
  });

  test("a change at the tail of a 20-line snippet is not clipped away by the window", () => {
    // 20 lines, only line 18 differs. A naive head truncation at 10 lines
    // would drop the change entirely. The window must center on the first
    // changed line so the user actually sees it.
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
    const oldSnippet = lines.join("\n");
    const newLines = lines.slice();
    newLines[17] = "row 18 CHANGED";
    const newSnippet = newLines.join("\n");
    const out = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "editFile",
        argumentsPreview: "app.ts",
        metadata: { oldSnippet, newSnippet },
      }),
      "compact",
      false
    );
    expect(out).toContain("- row 18");
    expect(out).toContain("+ row 18 CHANGED");
    expect(countDetailMarker(out, "- ")).toBe(1);
    expect(countDetailMarker(out, "+ ")).toBe(1);
  });

  test("CJK lines are clipped and padded by display width, not code-unit count", () => {
    // 60 CJK chars = 120 display columns but only 60 code units. A
    // `.length`-based clip at width 96 would let all 60 through (60 < 96);
    // the display-width clip must truncate and append "…".
    const cjk = "中".repeat(60);
    const out = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "editFile",
        argumentsPreview: "app.ts",
        metadata: { oldSnippet: cjk, newSnippet: `${cjk}X` },
      }),
      "compact",
      false
    );
    // The added line is the one at risk of overflowing; find it and verify
    // its visible width is within budget and ends with the ellipsis.
    const addedLine = out.split("\n").find((l) => l.startsWith("  + "));
    expect(addedLine).toBeDefined();
    const visible = stripAnsi(addedLine!).slice("  + ".length);
    expect(visible.endsWith("…")).toBe(true);
    // "+ " prefix (2) + visible glyphs must stay within MAX_WIDTH (96).
    expect(displayWidth(visible)).toBeLessThanOrEqual(96);
  });

  test("COLORTERM=truecolor produces a 48;2 background band of equal visible width across all diff lines", () => {
    // Mixed short and long changed lines: the rectangle must pad every line
    // to the same display width so the tint forms a clean band.
    const oldSnippet = "short\nmuch longer line than the previous one";
    const newSnippet = "shortX\nmuch longer line than the previous one too";
    const env = { COLORTERM: "truecolor", TERM: "xterm-256color", FORCE_COLOR: "1" } as Record<string, string>;
    const original = { ...process.env };
    Object.assign(process.env, env);
    try {
      const out = formatToolEventForCli(
        toolEvent({
          type: "tool-result",
          toolName: "editFile",
          argumentsPreview: "app.ts",
          metadata: { oldSnippet, newSnippet },
        }),
        "compact",
        true
      );
      expect(out).toContain("48;2");
      // Every diff line (added/removed/context) in the detail block must have
      // the same visible width — that is the Zed-style band invariant.
      const detailLines = out
        .split("\n")
        .filter((l) => l.startsWith("  ") && /\x1b\[/.test(l));
      expect(detailLines.length).toBeGreaterThan(0);
      const widths = detailLines.map((l) => displayWidth(stripAnsi(l).replace(/^ {2}/, "")));
      const first = widths[0];
      for (const w of widths) expect(w).toBe(first);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
      Object.assign(process.env, original);
    }
  });

  test("old === new yields no detail block (returns undefined upstream)", () => {
    // No change → formatEditFileSnippet returns undefined → no detail lines
    // in the compact output, just the main tool trace line.
    const snippet = "identical\ncontent\nhere";
    const out = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "editFile",
        argumentsPreview: "app.ts",
        metadata: { oldSnippet: snippet, newSnippet: snippet },
      }),
      "compact",
      false
    );
    expect(out).toContain("▸ Edit app.ts  ✓");
    expect(out).not.toContain("+ ");
    expect(out).not.toContain("- ");
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

  test("compact mode groups consecutive run events into tree view matching spec", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "r1", toolName: "execShell", argumentsPreview: "bun test tui/session.test.ts" }));
    format(toolEvent({ type: "tool-result", toolCallId: "r1", toolName: "execShell", argumentsPreview: "bun test tui/session.test.ts", metadata: { command: "bun test tui/session.test.ts", exitCode: 0 } }));
    format(toolEvent({ type: "tool-call", toolCallId: "r2", toolName: "execShell", argumentsPreview: "git status -sb" }));
    format(toolEvent({ type: "tool-result", toolCallId: "r2", toolName: "execShell", argumentsPreview: "git status -sb", metadata: { command: "git status -sb", exitCode: 0 } }));
    const out = format.flush ? format.flush() : "";
    expect(out).toBe(
      "• Run (2)\n" +
      "  ├── bun test tui/session.test.ts\n" +
      "  └── git status -sb\n"
    );
  });

  test("compact mode folds runCommand and launchProcess into the same Run tree", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "a1", toolName: "runCommand", argumentsPreview: "pwd" }));
    format(toolEvent({ type: "tool-result", toolCallId: "a1", toolName: "runCommand", argumentsPreview: "pwd", metadata: { command: "pwd", exitCode: 0 } }));
    format(toolEvent({ type: "tool-call", toolCallId: "a2", toolName: "launchProcess", argumentsPreview: "bun run dev" }));
    format(toolEvent({ type: "tool-result", toolCallId: "a2", toolName: "launchProcess", argumentsPreview: "bun run dev", metadata: { command: "bun run dev" } }));
    const out = format.flush ? format.flush() : "";
    expect(out).toBe(
      "• Run (2)\n" +
      "  ├── pwd\n" +
      "  └── bun run dev\n"
    );
  });

  test("compact mode annotates run leaf with non-zero exit code", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "f1", toolName: "execShell", argumentsPreview: "false" }));
    format(toolEvent({ type: "tool-result", toolCallId: "f1", toolName: "execShell", argumentsPreview: "false", metadata: { command: "false", exitCode: 1 } }));
    const out = format.flush ? format.flush() : "";
    expect(out).toBe(
      "• Run (1)\n" +
      "  └── false (exit 1)\n"
    );
  });

  test("compact mode does NOT fold action-gated run results into the Run tree", () => {
    const format = createToolEventFormatter("compact", false);
    // First a normal run that should be buffered.
    format(toolEvent({ type: "tool-call", toolCallId: "g1", toolName: "execShell", argumentsPreview: "git status -sb" }));
    format(toolEvent({ type: "tool-result", toolCallId: "g1", toolName: "execShell", argumentsPreview: "git status -sb", metadata: { command: "git status -sb", exitCode: 0 } }));
    // Then an action-gated run — must flush the buffered run and render the
    // handoff hint on its own line, not inside a tree.
    const out = format(toolEvent({
      type: "tool-result",
      toolCallId: "g2",
      toolName: "execShell",
      argumentsPreview: "gh auth refresh -s delete_repo",
      metadata: {
        exitCode: 130,
        actionGate: {
          id: "gate-test",
          kind: "handoff",
          title: "This command requires an interactive terminal.",
          payload: { command: ["gh", "auth", "refresh"], displayCommand: "gh auth refresh" },
        },
      },
    }));
    // Buffered run flushes first.
    expect(out).toContain("• Run (1)");
    expect(out).toContain("git status -sb");
    // Action-gated result stays on the generic line with the needs-action marker.
    expect(out).toContain("needs action");
    expect(out).toContain("gh auth refresh");
  });

  test("compact mode flushes Run tree before rendering a non-run tool", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "m1", toolName: "execShell", argumentsPreview: "echo hi" }));
    format(toolEvent({ type: "tool-result", toolCallId: "m1", toolName: "execShell", argumentsPreview: "echo hi", metadata: { command: "echo hi", exitCode: 0 } }));
    // A writeFile result interrupts the run streak — flush the run tree first.
    const writeLine = format(toolEvent({
      type: "tool-result",
      toolCallId: "m2",
      toolName: "writeFile",
      argumentsPreview: "out.txt",
    }));
    expect(writeLine).toContain("• Run (1)");
    expect(writeLine).toContain("echo hi");
    // The writeFile itself renders on the generic compact line after the flush.
    expect(writeLine).toContain("Write");
  });

  test("compact mode folds consecutive fetchWebpage events into a Fetch tree", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "w1", toolName: "fetchWebpage", argumentsPreview: "https://example.com/page1" }));
    format(toolEvent({ type: "tool-result", toolCallId: "w1", toolName: "fetchWebpage", argumentsPreview: "https://example.com/page1", metadata: { url: "https://example.com/page1" } }));
    format(toolEvent({ type: "tool-call", toolCallId: "w2", toolName: "fetchWebpage", argumentsPreview: "https://example.com/page2" }));
    format(toolEvent({ type: "tool-result", toolCallId: "w2", toolName: "fetchWebpage", argumentsPreview: "https://example.com/page2", metadata: { url: "https://example.com/page2" } }));
    const out = format.flush ? format.flush() : "";
    expect(out).toBe(
      "• Fetch (2)\n" +
      "  ├── https://example.com/page1\n" +
      "  └── https://example.com/page2\n"
    );
  });

  test("compact mode flushes Fetch tree before a non-fetch tool", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "w1", toolName: "fetchWebpage", argumentsPreview: "https://example.com/a" }));
    format(toolEvent({ type: "tool-result", toolCallId: "w1", toolName: "fetchWebpage", argumentsPreview: "https://example.com/a", metadata: { url: "https://example.com/a" } }));
    // A writeFile result interrupts the fetch streak — flush the fetch tree first.
    const writeLine = format(toolEvent({
      type: "tool-result",
      toolCallId: "x1",
      toolName: "writeFile",
      argumentsPreview: "out.txt",
    }));
    expect(writeLine).toContain("• Fetch (1)");
    expect(writeLine).toContain("https://example.com/a");
    // The writeFile itself renders on the generic compact line after the flush.
    expect(writeLine).toContain("Write");
  });

  test("compact mode folds consecutive exa_search events into a Web search tree", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "e1", toolName: "exa_search", argumentsPreview: "bun-nolo TUI web search tree" }));
    format(toolEvent({ type: "tool-result", toolCallId: "e1", toolName: "exa_search", argumentsPreview: "bun-nolo TUI web search tree" }));
    format(toolEvent({ type: "tool-call", toolCallId: "e2", toolName: "exa_search", argumentsPreview: "exa search query length limits" }));
    format(toolEvent({ type: "tool-result", toolCallId: "e2", toolName: "exa_search", argumentsPreview: "exa search query length limits" }));
    const out = format.flush ? format.flush() : "";
    expect(stripAnsi(out)).toBe(
      "• Web search (2)\n" +
      "  ├── bun-nolo TUI web search tree\n" +
      "  └── exa search query length limits\n"
    );
  });

  test("compact mode flushes Web search tree before a non-websearch tool", () => {
    const format = createToolEventFormatter("compact", false);
    format(toolEvent({ type: "tool-call", toolCallId: "e1", toolName: "exa_search", argumentsPreview: "open source bun runtime" }));
    format(toolEvent({ type: "tool-result", toolCallId: "e1", toolName: "exa_search", argumentsPreview: "open source bun runtime" }));
    // A non-websearch result interrupts the web search streak — flush the tree first.
    const writeLine = format(toolEvent({
      type: "tool-result",
      toolCallId: "x1",
      toolName: "writeFile",
      argumentsPreview: "out.txt",
    }));
    expect(writeLine).toContain("• Web search (1)");
    expect(writeLine).toContain("open source bun runtime");
    // The writeFile itself renders on the generic compact line after the flush.
    expect(writeLine).toContain("Write");
  });

  test("compact mode does NOT fold exa_search tool-error into the Web search tree", () => {
    const format = createToolEventFormatter("compact", false);
    // A prior successful web search should be buffered.
    format(toolEvent({ type: "tool-call", toolCallId: "e1", toolName: "exa_search", argumentsPreview: "nolo-plan skill system" }));
    format(toolEvent({ type: "tool-result", toolCallId: "e1", toolName: "exa_search", argumentsPreview: "nolo-plan skill system" }));
    // tool-error is not buffered — falls through to the generic compact line,
    // flushing the prior Web search tree first.
    const errLine = format(toolEvent({
      type: "tool-error",
      toolCallId: "e2",
      toolName: "exa_search",
      argumentsPreview: "nolo-plan unknown topic",
      message: "rate limit exceeded",
    }));
    expect(errLine).toContain("• Web search (1)");
    expect(errLine).toContain("nolo-plan skill system");
    // The error itself renders on the generic trace line with the ✗ marker.
    expect(errLine).toContain("✗");
  });

  test("compact mode does NOT fold fetchWebpage tool-error into the Fetch tree", () => {
    const format = createToolEventFormatter("compact", false);
    // A prior fetch should be buffered.
    format(toolEvent({ type: "tool-call", toolCallId: "w1", toolName: "fetchWebpage", argumentsPreview: "https://example.com/ok" }));
    format(toolEvent({ type: "tool-result", toolCallId: "w1", toolName: "fetchWebpage", argumentsPreview: "https://example.com/ok", metadata: { url: "https://example.com/ok" } }));
    // tool-error is not buffered — falls through to the generic compact line,
    // flushing the prior fetch tree first.
    const errLine = format(toolEvent({
      type: "tool-error",
      toolCallId: "w2",
      toolName: "fetchWebpage",
      argumentsPreview: "https://example.com/bad",
      message: "connection refused",
    }));
    expect(errLine).toContain("• Fetch (1)");
    expect(errLine).toContain("https://example.com/ok");
    // The error itself renders on the generic trace line with the ✗ marker.
    expect(errLine).toContain("✗");
  });

  test("compact mode renders loadSkill as single-line i18n badge (no color)", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "loadSkill",
        argumentsPreview: "nolo-plan",
        content: 'Skill "nolo-plan" loaded inline. Follow its instructions.',
      }),
      "compact",
      false
    );
    expect(line).toBe("✦ Used Skill: nolo-plan\n");
  });

  test("compact mode loadSkill prefers metadata.name and falls back to content parsing", () => {
    // metadata.name takes precedence over argumentsPreview.
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "loadSkill",
        argumentsPreview: '{ "name": "ignored" }',
        metadata: { name: "search-first" },
        content: 'Skill "search-first" loaded inline. Follow its instructions.',
      }),
      "compact",
      false
    );
    expect(line).toBe("✦ Used Skill: search-first\n");
    // No-color path must not emit ANSI escapes.
    expect(line).not.toContain("\x1b");
  });

  test("compact mode loadSkill with color emits single-line success star and badge", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "loadSkill",
        argumentsPreview: "nolo-plan",
        content: 'Skill "nolo-plan" loaded inline. Follow its instructions.',
      }),
      "compact",
      true
    );
    expect(line).toContain("Used Skill");
    expect(line).toContain("nolo-plan");
    expect(line).toContain("✦");
    // Single line output
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
    // ANSI present (color enabled).
    expect(line).toContain("\x1b");
  });

  test("compact mode loadSkill tool-error falls through to the generic ✗ line", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-error",
        toolName: "loadSkill",
        argumentsPreview: "nolo-plan",
        message: "skill not found",
      }),
      "compact",
      false
    );
    // tool-error keeps the existing ✗ convention; no Used Skill block.
    expect(line).toContain("✗");
    expect(line).toContain("skill not found");
    // The inline-loaded detail line must not appear on a failure.
    expect(line).not.toContain("loaded inline");
    // Single trace line, not the two-line success block.
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("compact mode loadSkill not-found result renders ✗ instead of success block", () => {
    // not-found is a plain tool-result (executors return text, never throw):
    // it must render as failure, consistent with the web/RN renderers.
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "loadSkill",
        argumentsPreview: "ghost",
        content:
          'Skill "ghost" not found in this workspace\'s skill directory (.agents/skills/<name>/SKILL.md).\n\nAvailable skills: nolo-plan',
      }),
      "compact",
      false
    );
    expect(line).toContain("✗");
    expect(line).toContain("Used Skill (ghost)");
    expect(line).toContain("not found");
    expect(line).not.toContain("loaded inline");
    expect(line).not.toContain("●");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("compact mode renders listAgents / startAgentRun / controlAgentRun as formatted cards (no color)", () => {
    const listLine = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "listAgents",
        metadata: {
          displayData: "Agents (2)\n★ Agent A  model-x  platform\n  Agent B  model-y  custom",
        },
      }),
      "compact",
      false
    );
    expect(listLine).toBe("● listAgents\n  Agents (2)\n  ★ Agent A  model-x  platform\n    Agent B  model-y  custom\n");

    const startLine = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "startAgentRun",
        metadata: {
          displayData: "Run started\n  agent   agent-a\n  runId   run-123\n  pid     999",
        },
      }),
      "compact",
      false
    );
    expect(startLine).toBe("● startAgentRun\n  Run started\n    agent   agent-a\n    runId   run-123\n    pid     999\n");

    const controlLine = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "controlAgentRun",
        metadata: {
          displayData: "Run stopped\n  🛑 killed\n  runId   run-123",
        },
      }),
      "compact",
      false
    );
    expect(controlLine).toBe("● controlAgentRun\n  Run stopped\n    🛑 killed\n    runId   run-123\n");
  });

  test("compact mode orchestration card recovers readable card from JSON content when displayData missing", () => {
    const listLine = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "listAgents",
        content: JSON.stringify({
          success: true,
          total: 1,
          agents: [
            {
              name: "Agent A",
              model: "model-x",
              apiSource: "platform",
              isFavorite: true,
              publicKey: "agent-pub-a",
            },
          ],
        }),
      }),
      "compact",
      false
    );
    expect(listLine).toBe(
      "● listAgents\n  Agents (1)\n  ★  Agent A  model-x  platform\n"
    );

    const startLine = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "startAgentRun",
        content: JSON.stringify({ runId: "run-9", status: "pending" }),
      }),
      "compact",
      false
    );
    expect(startLine).toContain("● startAgentRun");
    expect(startLine).toContain("Run started");
    expect(startLine).not.toContain("runId");
    expect(startLine).not.toContain('{"runId"');
  });

  test("compact mode orchestration card renders failure line with ✗ when failed", () => {
    const failLine = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "startAgentRun",
        content: "Error: missing agentKey",
        metadata: { failed: true },
      }),
      "compact",
      false
    );
    expect(failLine).toContain("✗ startAgentRun");
    expect(failLine).toContain("Error: missing agentKey");
  });

  test("compact mode folds consecutive controlAgentRun status polls for the same runId", () => {
    const format = createToolEventFormatter("compact", false);
    const logLines = ["agent-xxx → working locally", "✦ Used Skill: nolo-review"];
    for (let i = 0; i < 4; i++) {
      format(
        toolEvent({
          type: "tool-call",
          toolCallId: `c-status-${i}`,
          toolName: "controlAgentRun",
        })
      );
      expect(
        format(
          toolEvent({
            type: "tool-result",
            toolCallId: `c-status-${i}`,
            toolName: "controlAgentRun",
            elapsedMs: 10 + i,
            content: JSON.stringify({
              runId: "run-fold-1",
              found: true,
              status: "running",
              agentName: "Worker",
              toolCallCount: i + 1,
              lastToolNames: ["readFile"],
              logLines,
            }),
          })
        )
      ).toBe("");
    }
    const out = format.flush ? format.flush() : "";
    // One card, not four full cards.
    expect(out.match(/● controlAgentRun/g)?.length ?? 0).toBe(1);
    expect(out.match(/Run status/g)?.length ?? 0).toBe(1);
    expect(out).toContain("⏳ running");
    expect(out).toContain("agent   Worker  #fold-1");
    // Latest poll wins for the progress row.
    expect(out).toContain("tools   4 tools · readFile");
    // Observer detail (how often the model polled, how fast the endpoint
    // answered) is not run state and must not reach the card.
    expect(out).not.toContain("polls");
    expect(out).not.toContain("13ms");
    // A healthy run's stdout stays off the card entirely.
    expect(out).not.toContain("Log tail:");
    expect(out).not.toContain("agent-xxx → working locally");
  });

  // Log tails only reach a card once a run has failed, so the dedupe that keeps
  // an unchanged tail from being redrawn is exercised on a failed run.
  test("a repeated poll does not redraw an unchanged log tail", () => {
    const format = createToolEventFormatter("compact", false);
    const logLines = ["same-tail"];
    const failedPoll = (toolCallId: string) =>
      format(
        toolEvent({
          type: "tool-result",
          toolCallId,
          toolName: "controlAgentRun",
          content: JSON.stringify({
            runId: "run-fold-2",
            status: "failed",
            agentName: "Worker",
            logLines,
          }),
        })
      );

    // Terminal statuses flush immediately, so each poll emits its own card.
    const first = failedPoll("s1");
    expect(first).toContain("Log tail:");
    expect(first).toContain("same-tail");

    const second = failedPoll("s2");
    expect(second).toContain("● controlAgentRun");
    expect(second).not.toContain("Log tail:");
    expect(second).not.toContain("same-tail");
  });

  test("a tail withheld while the run was healthy still prints when it fails", () => {
    // The tail dedupe must only remember tails it actually printed. Banking the
    // key on every poll would mark a never-shown tail as already seen and
    // suppress it on the failure card — the one card that exists to show it.
    const format = createToolEventFormatter("compact", false);
    const logLines = ["connecting", "boom"];
    const poll = (toolCallId: string, status: string) =>
      format(
        toolEvent({
          type: "tool-result",
          toolCallId,
          toolName: "controlAgentRun",
          content: JSON.stringify({ runId: "run-l", status, agentName: "Worker", logLines }),
        })
      );

    expect(poll("p1", "running")).toBe("");
    const out = poll("p2", "failed");

    expect(out).toContain("Log tail:");
    expect(out).toContain("boom");
  });

  test("a status transition breaks the fold so the ending gets its own card", () => {
    const format = createToolEventFormatter("compact", false);
    const poll = (toolCallId: string, status: string, extra: Record<string, unknown> = {}) =>
      format(
        toolEvent({
          type: "tool-result",
          toolCallId,
          toolName: "controlAgentRun",
          content: JSON.stringify({
            runId: "run-t",
            status,
            agentName: "Worker",
            ...extra,
          }),
        })
      );

    expect(poll("p1", "running", { toolCallCount: 3 })).toBe("");
    expect(poll("p2", "running", { toolCallCount: 8 })).toBe("");
    // running → done: the progress card closes and a finished card opens.
    const out = poll("p3", "done");

    expect(out).toContain("Run status");
    expect(out).toContain("⏳ running");
    // Progress from the folded polls survives into the closing card.
    expect(out).toContain("tools   8 tools");
    expect(out).toContain("Run finished");
    expect(out).toContain("✓ done");
    expect(format.flush ? format.flush() : "").toBe("");
  });

  test("a finished run reports totals a terminal poll did not repeat", () => {
    const format = createToolEventFormatter("compact", false);
    format(
      toolEvent({
        type: "tool-result",
        toolCallId: "p1",
        toolName: "controlAgentRun",
        content: JSON.stringify({
          runId: "run-c",
          status: "running",
          agentName: "Worker",
          toolCallCount: 31,
          startedAt: 1_000_000,
        }),
      })
    );
    // The terminal poll carries only the outcome; totals are carried forward.
    const out = format(
      toolEvent({
        type: "tool-result",
        toolCallId: "p2",
        toolName: "controlAgentRun",
        content: JSON.stringify({
          runId: "run-c",
          status: "done",
          agentName: "Worker",
          finishedAt: 1_000_000 + 242_000,
        }),
      })
    );
    expect(out).toContain("Run finished");
    expect(out).toContain("31 tools");
    expect(out).toContain("4m02s");
  });

  test("controlAgentRun status without agentName does not render agent   agent", () => {
    const line = formatToolEventForCli(
      toolEvent({
        type: "tool-result",
        toolName: "controlAgentRun",
        content: JSON.stringify({
          runId: "run-x",
          status: "running",
          logLines: ["hello"],
        }),
      }),
      "compact",
      false
    );
    expect(line).toContain("● controlAgentRun");
    expect(line).toContain("⏳ running");
    expect(line).not.toContain("agent   agent");
    expect(line.split("\n").some((l) => /^\s*agent\s+agent\s*$/.test(l))).toBe(false);
  });

  test("folded controlAgentRun keeps terminal status and errorMessage visible", () => {
    const format = createToolEventFormatter("compact", false);
    format(
      toolEvent({
        type: "tool-result",
        toolCallId: "t1",
        toolName: "controlAgentRun",
        elapsedMs: 11,
        content: JSON.stringify({
          runId: "run-term",
          status: "running",
          agentName: "Worker",
          logLines: ["working"],
        }),
      })
    );
    // Terminal poll flushes immediately with error still present.
    const out = format(
      toolEvent({
        type: "tool-result",
        toolCallId: "t2",
        toolName: "controlAgentRun",
        elapsedMs: 22,
        content: JSON.stringify({
          runId: "run-term",
          status: "failed",
          agentName: "Worker",
          errorMessage: "API key expired",
          logLines: ["working", "boom"],
        }),
      })
    );
    expect(out).toContain("● controlAgentRun");
    expect(out).toContain("✗ failed");
    expect(out).toContain("error   API key expired");
    // Flush should be empty — terminal already emitted.
    expect(format.flush ? format.flush() : "").toBe("");
  });

  test("tree group headers follow locale on both colorEnabled branches", () => {
    const items = {
      read: [{ path: "a.ts" }],
      search: [{ query: "foo" }],
      run: [{ command: "echo hi" }],
      fetch: [{ url: "https://example.com" }],
    };

    setCliLocale("en");
    for (const colorEnabled of [false, true]) {
      const read = stripAnsi(formatReadTreeBlockForCli(items.read, colorEnabled));
      const search = stripAnsi(formatSearchTreeBlockForCli(items.search, colorEnabled));
      const run = stripAnsi(formatRunTreeBlockForCli(items.run, colorEnabled));
      const fetch = stripAnsi(formatFetchTreeBlockForCli(items.fetch, colorEnabled));
      expect(read).toContain("• Read (1)");
      expect(search).toContain("• Search (1)");
      expect(run).toContain("• Run (1)");
      expect(fetch).toContain("• Fetch (1)");
      expect(read).not.toContain("读取");
      expect(fetch).not.toContain("抓取网页");
    }

    setCliLocale("zh");
    for (const colorEnabled of [false, true]) {
      const read = stripAnsi(formatReadTreeBlockForCli(items.read, colorEnabled));
      const search = stripAnsi(formatSearchTreeBlockForCli(items.search, colorEnabled));
      const run = stripAnsi(formatRunTreeBlockForCli(items.run, colorEnabled));
      const fetch = stripAnsi(formatFetchTreeBlockForCli(items.fetch, colorEnabled));
      expect(read).toContain("• 读取 (1)");
      expect(search).toContain("• 搜索 (1)");
      expect(run).toContain("• 执行 (1)");
      expect(fetch).toContain("• 抓取网页 (1)");
      expect(read).not.toContain("• Read (");
      expect(fetch).not.toContain("• Fetch (");
    }
  });
});

describe("toolOutput transcript ordering", () => {
  const ev = (o: Partial<LocalAgentToolEvent>) =>
    ({ round: 0, toolCallId: "x", toolName: "t", type: "tool-result", ...o }) as LocalAgentToolEvent;

  // Both a status card and a read tree are held back; whichever class the next
  // event does not belong to has to be emitted first, or the transcript reports
  // them out of the order they happened.
  test("a tool between two polls prints between their cards", () => {
    const format = createToolEventFormatter("compact", false);
    let out = "";
    out += format(
      ev({
        toolCallId: "c1",
        toolName: "controlAgentRun",
        content: JSON.stringify({ runId: "r1", status: "running", agentName: "W" }),
      })
    );
    out += format(ev({ toolCallId: "rr", toolName: "readFile", metadata: { path: "a.ts" } }));
    out += format(
      ev({
        toolCallId: "c2",
        toolName: "controlAgentRun",
        content: JSON.stringify({ runId: "r1", status: "done", agentName: "W" }),
      })
    );
    out += format.flush ? format.flush() : "";

    const runningAt = out.indexOf("running");
    const readAt = out.indexOf("a.ts");
    const doneAt = out.indexOf("done");
    expect(runningAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(runningAt);
    expect(doneAt).toBeGreaterThan(readAt);
  });
});
