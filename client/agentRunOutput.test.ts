import { describe, expect, test } from "bun:test";

import { createCliTurnOutput } from "./agentRunOutput";
import {
  createHistoryOutputStream,
  createTurnHistory,
  finalizeCurrentTurn,
  startTurn,
} from "../tui/tuiHistory";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import type { RunAgentTurnOptions } from "./agentRunTypes";

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
    expect(visible).toContain("• Read (");
    expect(visible).toContain("• Search (");
    expect(visible).toContain("• Run (");
  });

  test("no spinner frame residue (no (Ns) elapsed markers)", () => {
    const visible = runEventSequence();
    // Spinner frames leave "· Label (0s)" or "(1s)" etc. The folded tree
    // should be the only tool representation; no elapsed-seconds parenthetical
    // from a spinner frame should survive.
    expect(visible).not.toMatch(/· .* \(\d+s\)/);
  });

  test("no block of ≥2 consecutive blank lines in the tool region", () => {
    const visible = runEventSequence();
    const lines = visible.split("\n");
    // Find the tool region: from the first tool line (List/Read/Search/Run)
    // to the last tool line (Write). Trailing blank lines after the final
    // text are finish() padding and are not part of this regression.
    const firstToolIdx = lines.findIndex((l) =>
      /▸ (List|Read|Search|Run|Write)/.test(l) ||
      /• (Read|Search|Run|Fetch)\(/.test(l),
    );
    const lastToolIdx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /▸ (List|Read|Search|Run|Write)/.test(l) ||
        /• (Read|Search|Run|Fetch)\(/.test(l))
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