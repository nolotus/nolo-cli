import { describe, expect, test } from "bun:test";

import { parseAgentRunEvent } from "./agentRunSnapshot";
import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";

function event(overrides: Partial<LocalAgentToolEvent>): LocalAgentToolEvent {
  return {
    type: "tool-result",
    round: 0,
    toolCallId: "call-1",
    toolName: "controlAgentRun",
    ...overrides,
  } as LocalAgentToolEvent;
}

function payload(toolName: string, body: Record<string, unknown>): LocalAgentToolEvent {
  return event({ toolName, content: JSON.stringify(body) });
}

describe("parseAgentRunEvent", () => {
  test("classifies the four single-run shapes", () => {
    expect(
      parseAgentRunEvent(payload("startAgentRun", { runId: "r1", status: "pending" }))?.kind
    ).toBe("start");
    expect(
      parseAgentRunEvent(payload("controlAgentRun", { runId: "r1", status: "running" }))?.kind
    ).toBe("status");
    expect(
      parseAgentRunEvent(payload("controlAgentRun", { runId: "r1", status: "killed" }))?.kind
    ).toBe("stop");
    expect(
      parseAgentRunEvent(payload("controlAgentRun", { runId: "r1", found: false }))?.kind
    ).toBe("gone");
  });

  test("declines payloads that are not one run", () => {
    // A set of runs — neither the fold nor the panel can act on it.
    expect(parseAgentRunEvent(payload("controlAgentRun", { runs: [], count: 0 }))).toBeNull();
    // Not JSON, not a run tool, not a result.
    expect(parseAgentRunEvent(event({ content: "plain text" }))).toBeNull();
    expect(parseAgentRunEvent(payload("readFile", { runId: "r1", status: "running" }))).toBeNull();
    expect(
      parseAgentRunEvent(event({ type: "tool-call", content: JSON.stringify({ runId: "r1" }) }))
    ).toBeNull();
    // Malformed JSON must not throw.
    expect(parseAgentRunEvent(event({ content: "{not json" }))).toBeNull();
  });

  test("carries the progress fields the server already reports", () => {
    const parsed = parseAgentRunEvent(
      payload("controlAgentRun", {
        runId: "r1",
        status: "running",
        agentName: "Worker",
        toolCallCount: 12,
        lastToolNames: ["readFile", "grep"],
        lastAssistantText: "  located the cache boundary  ",
      })
    );
    expect(parsed?.snapshot).toMatchObject({
      runId: "r1",
      agentName: "Worker",
      toolCallCount: 12,
      lastToolNames: ["readFile", "grep"],
      lastAssistantText: "located the cache boundary",
    });
  });

  test("resolves a name without ever labelling a run 'agent'", () => {
    // agentKey is the last real identity; the literal "agent" fallback is
    // dropped so renderers show no name row rather than the word "agent".
    expect(
      parseAgentRunEvent(payload("controlAgentRun", { runId: "r1", status: "running" }))?.snapshot
        .agentName
    ).toBeUndefined();
    expect(
      parseAgentRunEvent(
        payload("controlAgentRun", { runId: "r1", status: "running", agentKey: "agent-x" })
      )?.snapshot.agentName
    ).toBe("agent-x");
  });

  test("never resolves the name to the runId", () => {
    // runId is carried separately and rendered as a #suffix; resolving the
    // label to it too would print the same id twice.
    const snapshot = parseAgentRunEvent(
      payload("controlAgentRun", { runId: "run-xyz", status: "running" })
    )?.snapshot;
    expect(snapshot?.agentName).toBeUndefined();
    expect(snapshot?.runId).toBe("run-xyz");
  });

  test("accepts logTail as an alternative to logLines and keys them alike", () => {
    const fromTail = parseAgentRunEvent(
      payload("controlAgentRun", { runId: "r1", status: "running", logTail: "a\nb" })
    )?.snapshot;
    const fromLines = parseAgentRunEvent(
      payload("controlAgentRun", { runId: "r1", status: "running", logLines: ["a", "b"] })
    )?.snapshot;
    expect(fromTail?.logLines).toEqual(["a", "b"]);
    expect(fromTail?.logKey).toBe(fromLines?.logKey);
  });

  test("falls back to the event's runId metadata", () => {
    const parsed = parseAgentRunEvent(
      event({ content: JSON.stringify({ status: "running" }), metadata: { runId: "meta-run" } })
    );
    expect(parsed?.snapshot.runId).toBe("meta-run");
  });

  test("reads run timing from either producer's field names", () => {
    // The server sends epoch millis under `finishedAt`; the CLI's local run
    // registry sends ISO strings under `endedAt`. Same fact, two producers.
    const server = parseAgentRunEvent(
      payload("controlAgentRun", {
        runId: "r1",
        status: "done",
        startedAt: 1_000_000,
        finishedAt: 1_060_000,
      })
    )?.snapshot;
    expect(server).toMatchObject({ startedAt: 1_000_000, finishedAt: 1_060_000 });

    const local = parseAgentRunEvent(
      payload("controlAgentRun", {
        runId: "r1",
        status: "done",
        startedAt: "2026-08-08T00:00:00.000Z",
        endedAt: "2026-08-08T00:01:00.000Z",
      })
    )?.snapshot;
    expect(local?.finishedAt! - local?.startedAt!).toBe(60_000);
  });

  test("treats unusable timestamps as absent", () => {
    // A run that claims to have started at epoch 0 would render an age of
    // decades; no duration is better than a wrong one.
    const snapshot = parseAgentRunEvent(
      payload("controlAgentRun", {
        runId: "r1",
        status: "running",
        startedAt: 0,
        finishedAt: "not a date",
      })
    )?.snapshot;
    expect(snapshot?.startedAt).toBeUndefined();
    expect(snapshot?.finishedAt).toBeUndefined();
  });

  test("a status report with no id and no status is not a run report", () => {
    expect(parseAgentRunEvent(payload("controlAgentRun", { status: "running" }))).toBeNull();
    expect(parseAgentRunEvent(payload("controlAgentRun", { runId: "r1" }))).toBeNull();
  });
});
