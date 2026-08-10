import { describe, expect, test } from "bun:test";

import { createCliTurnOutput } from "./agentRunOutput";
import { createSseToolEventAdapter } from "./toolOutput";
import {
  createHistoryOutputStream,
  createTurnHistory,
  finalizeCurrentTurn,
  startTurn,
} from "../tui/tuiHistory";
import { toolLabel } from "../tui/i18n";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import type { RunAgentTurnOptions } from "./agentRunTypes";

/** Escape a localized label so it is safe to embed in a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regression: TUI transcript showed ~19 blank lines between `▸ List … ✓`
 * and `▸ Write … ✓`. Two bugs in handleToolEvent caused this:
 *
 * 1. The compact tool-call branch called `spinner.show()` then `return`
 *    before writing the chunk — so `flushBuffers()` tree output (`• Read
 *    (N)` etc.) was silently discarded.
 * 2. `spinner.stop()` was placed after `if (!chunk) return`, so buffered
 *    tool-results (chunk="") left spinner zombie frames (`· Read … (0s)`)
 *    permanently in the transcript.
 *
 * This test feeds the exact event pattern (text → listFiles → many
 * buffered read/search/exec → text → writeFile → finish) and asserts the
 * folded trees appear, no spinner frames linger, and no ≥2 consecutive
 * blank-line blocks exist.
 */
describe("createCliTurnOutput compact tool tree regression", () => {
  function runEventSequence(): string {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    const stream = createHistoryOutputStream(history, () => {});

    const options = {
      output: stream as unknown as NodeJS.WritableStream,
      agentName: "TestAgent",
      env: { COLORTERM: "truecolor" },
    } as unknown as RunAgentTurnOptions;

    const turn = createCliTurnOutput({ options });

    let id = 0;
    const tool = (name: string, args: string, ok = true) => {
      id += 1;
      const callId = String(id);
      turn.handleToolEvent({
        type: "tool-call",
        toolName: name,
        toolCallId: callId,
        round: id,
        argumentsPreview: args,
      } as LocalAgentToolEvent);
      turn.handleToolEvent({
        type: "tool-result",
        toolName: name,
        toolCallId: callId,
        round: id,
        summary: ok ? "exit=0" : "exit=1",
        metadata: {
          exitCode: ok ? 0 : 1,
          path: name === "readFile" ? args : undefined,
          query: name === "searchFiles" ? args : undefined,
          command: name === "execShell" ? args : undefined,
        },
        elapsedMs: 42,
      } as LocalAgentToolEvent);
    };

    turn.pushText("Starting work. Locating files.\n");
    tool("listFiles", "packages/cli/tui");
    tool("readFile", "packages/cli/tui/theme.ts");
    tool("execShell", "nolo table list --json");
    tool("searchFiles", "codeSpan|inlineCode");
    tool("searchFiles", "heading|markdown");
    tool("execShell", "nolo table query --json");
    tool("readFile", "packages/cli/client/assistantOutput.ts");
    tool("readFile", "packages/cli/tui/theme.ts");
    tool("searchFiles", "highlightMarkdown");
    tool("searchFiles", "cursor");
    tool("execShell", "grep -ri theme ~/.nolo");
    tool("searchFiles", "setActiveThemeName");
    tool("execShell", "bun test packages/cli/tui packages/cli/client");
    turn.pushText("Found everything. Writing spec.\n");
    tool("writeFile", "docs/task-specs/example.md");
    turn.pushText("Done.\n");
    turn.finish();
    finalizeCurrentTurn(history);

    // Strip ANSI escape sequences for plain-text assertions.
    return history.turns
      .map((t) => t.content)
      .join("\n")
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  }

  test("folded tool trees appear in transcript", () => {
    const visible = runEventSequence();
    // Tree headers are localized (toolLabel), so assert against the same label
    // source rather than an English literal — otherwise this test just pins the
    // current locale and breaks whenever the translation changes.
    expect(visible).toContain(`• ${toolLabel("readFile")} (`);
    expect(visible).toContain(`• ${toolLabel("searchFiles")} (`);
    expect(visible).toContain(`• ${toolLabel("execShell")} (`);
  });

  test("buffered tool tree flushes before subsequent text (not at finish)", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    const stream = createHistoryOutputStream(history, () => {});
    const options = {
      output: stream as unknown as NodeJS.WritableStream,
      agentName: "TestAgent",
      env: { COLORTERM: "truecolor" },
    } as unknown as RunAgentTurnOptions;
    const turn = createCliTurnOutput({ options });

    const readTool = (path: string) => {
      turn.handleToolEvent({
        type: "tool-call",
        toolName: "readFile",
        toolCallId: path,
        round: 1,
        argumentsPreview: path,
      } as LocalAgentToolEvent);
      turn.handleToolEvent({
        type: "tool-result",
        toolName: "readFile",
        toolCallId: path,
        round: 1,
        summary: "exit=0",
        metadata: { exitCode: 0, path },
        elapsedMs: 10,
      } as LocalAgentToolEvent);
    };

    // readFile is a buffered tool: its tree is held inside the formatter.
    turn.pushText("Start.\n");
    readTool("a.ts");
    // Next text delta must flush the pending tree BEFORE the text, so the
    // tool appears mid-transcript instead of piling up at finish().
    turn.pushText("Middle.\n");
    readTool("b.ts");
    turn.pushText("End.\n");
    turn.finish();
    finalizeCurrentTurn(history);

    const visible = history.turns
      .map((t) => t.content)
      .join("\n")
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    const firstTree = `• ${toolLabel("readFile")} (`;
    expect(visible.indexOf(firstTree)).toBeGreaterThan(visible.indexOf("Start."));
    // First readFile tree flushed before "Middle." — not deferred to finish().
    expect(visible.indexOf(firstTree)).toBeLessThan(visible.indexOf("Middle."));
    // Both readFile entries appear.
    expect(visible.match(new RegExp(`• ${escapeForRegExp(toolLabel("readFile"))} \\(`, "g"))?.length).toBe(2);
  });

  test("no spinner frame residue (no (Ns) elapsed markers)", () => {
    const visible = runEventSequence();
    // Spinner frames leave "· Label (0s)" or "(1s)" etc. The folded tree
    // should be the only tool representation; no elapsed-seconds parenthetical
    // from a spinner frame should survive.
    expect(visible).not.toMatch(/· .* \(\d+s\)/);
  });

  function collectPanelUpdates(events: LocalAgentToolEvent[]): unknown[] {
    const output: string[] = [];
    const statusUpdates: unknown[] = [];
    const options = {
      output: { write: (chunk: string) => output.push(chunk) },
      agentName: "TestAgent",
      env: { COLORTERM: "truecolor" },
      onAgentRunStatus: (snapshot: unknown) => statusUpdates.push(snapshot),
    } as unknown as RunAgentTurnOptions;
    const turn = createCliTurnOutput({ options });
    for (const event of events) turn.handleToolEvent(event);
    return statusUpdates;
  }

  // The panel used to subscribe to startAgentRun only, which pinned it to the
  // run's first status: polls reporting `done` never reached it and the dock
  // kept claiming `running` until the turn ended.
  test("controlAgentRun status polls update the composer dock panel", () => {
    const updates = collectPanelUpdates([
      {
        type: "tool-result",
        toolName: "startAgentRun",
        toolCallId: "start-1",
        round: 0,
        content: JSON.stringify({ runId: "run-1", status: "running", agentName: "Worker" }),
      },
      {
        type: "tool-result",
        toolName: "controlAgentRun",
        toolCallId: "control-1",
        round: 1,
        content: JSON.stringify({
          runId: "run-1",
          status: "done",
          agentName: "Worker",
          toolCallCount: 7,
        }),
      },
    ] as LocalAgentToolEvent[]);

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ runId: "run-1", status: "running" });
    expect(updates[1]).toMatchObject({ runId: "run-1", status: "done", toolCallCount: 7 });
  });

  // The dock holds several runs now, so a vanished run has to be named: it is
  // forwarded as its own `not_found` snapshot (the dock drops that row) rather
  // than as a blanket `null`, which would have wiped live sibling runs too.
  test("a run the server no longer knows about is reported as not_found, by id", () => {
    const updates = collectPanelUpdates([
      {
        type: "tool-result",
        toolName: "controlAgentRun",
        toolCallId: "control-1",
        round: 1,
        content: JSON.stringify({ runId: "run-gone", found: false }),
      },
    ] as LocalAgentToolEvent[]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ runId: "run-gone", status: "not_found" });
  });

  test("controlAgentRun list results leave the dock panel untouched", () => {
    const updates = collectPanelUpdates([
      {
        type: "tool-result",
        toolName: "controlAgentRun",
        toolCallId: "control-1",
        round: 1,
        content: JSON.stringify({ runs: [{ runId: "a" }, { runId: "b" }], count: 2 }),
      },
    ] as LocalAgentToolEvent[]);

    expect(updates).toEqual([]);
  });

  test("no block of ≥2 consecutive blank lines in the tool region", () => {
    const visible = runEventSequence();
    const lines = visible.split("\n");
    // Find the tool region: from the first tool line (List/Read/Search/Run)
    // to the last tool line (Write). Trailing blank lines after the final
    // text are finish() padding and are not part of this regression.
    // Labels are localized, so build the matcher from the same label source
    // instead of hardcoding English names.
    const inlineNames = ["listFiles", "readFile", "searchFiles", "execShell", "writeFile"]
      .map((name) => escapeForRegExp(toolLabel(name)))
      .join("|");
    const treeNames = ["readFile", "searchFiles", "execShell", "fetchWebpage"]
      .map((name) => escapeForRegExp(toolLabel(name)))
      .join("|");
    const isToolLine = (l: string) =>
      new RegExp(`▸ (${inlineNames})`).test(l) ||
      new RegExp(`• (${treeNames})\\s*\\(`).test(l);

    const firstToolIdx = lines.findIndex(isToolLine);
    const lastToolIdx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => isToolLine(l))
      .reduce((max, { i }) => Math.max(max, i), -1);

    expect(firstToolIdx).toBeGreaterThanOrEqual(0);
    expect(lastToolIdx).toBeGreaterThan(firstToolIdx);

    let maxBlankRun = 0;
    let currentBlankRun = 0;
    for (let i = firstToolIdx; i <= lastToolIdx; i++) {
      if (lines[i].trim() === "") {
        currentBlankRun += 1;
        maxBlankRun = Math.max(maxBlankRun, currentBlankRun);
      } else {
        currentBlankRun = 0;
      }
    }
    // A single blank line between sections is fine; ≥2 consecutive blanks
    // in the tool region indicate zombie spinner lines or stray newlines
    // from buffered tools — the exact regression we are fixing.
    expect(maxBlankRun).toBeLessThan(2);
  });
});
describe("HTTP/SSE path parity", () => {
  // The SSE adapter used to clip the payload into `summary` and drop `content`
  // entirely, so every consumer that parses structured results — the dock panel
  // among them — was silently inert on the server path while working locally.
  test("an SSE tool result reaches the dock panel like a local one does", () => {
    const statusUpdates: unknown[] = [];
    const options = {
      output: { write: () => {} },
      agentName: "TestAgent",
      env: { COLORTERM: "truecolor" },
      onAgentRunStatus: (snapshot: unknown) => statusUpdates.push(snapshot),
    } as unknown as RunAgentTurnOptions;
    const turn = createCliTurnOutput({ options });
    const sse = createSseToolEventAdapter((evt) => turn.handleToolEvent(evt));

    sse.onToolStart({ calls: [{ toolCallId: "t1", toolName: "startAgentRun" }] });
    sse.onToolResult({
      toolCallId: "t1",
      toolName: "startAgentRun",
      content: JSON.stringify({ runId: "run-1", status: "running", agentName: "Worker" }),
    });
    sse.onToolEnd();
    sse.onToolStart({ calls: [{ toolCallId: "t2", toolName: "controlAgentRun" }] });
    sse.onToolResult({
      toolCallId: "t2",
      toolName: "controlAgentRun",
      content: JSON.stringify({
        runId: "run-1",
        status: "done",
        agentName: "Worker",
        toolCallCount: 9,
      }),
    });

    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates[0]).toMatchObject({ runId: "run-1", status: "running" });
    expect(statusUpdates[1]).toMatchObject({ runId: "run-1", status: "done", toolCallCount: 9 });
  });

  test("the SSE adapter preserves the full payload, not just a clipped summary", () => {
    const events: any[] = [];
    const sse = createSseToolEventAdapter((evt) => events.push(evt));
    const content = JSON.stringify({ runId: "r", status: "running", note: "x".repeat(400) });
    sse.onToolStart({ calls: [{ toolCallId: "t1", toolName: "controlAgentRun" }] });
    sse.onToolResult({ toolCallId: "t1", toolName: "controlAgentRun", content });

    const result = events.find((e) => e.type === "tool-result");
    expect(result.content).toBe(content);
    // summary stays clipped — it is the one-line label, not the payload.
    expect(result.summary.length).toBeLessThan(content.length);
  });
});
