import { beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";

import { expectNoRetiredTaskOrchestrationTerms } from "../../../scripts/helpers/retiredTaskOrchestrationTerms";
import {
  classifyReviewDecisionStatus,
  findServerPlatformTools,
  runAgentTurn,
} from "./agentRun";
import { setCliLocale } from "../tui/i18n";
import { BUILTIN_NOLO_AGENT_KEY } from "./localRuntimeAdapter";
import { NOLO_PROJECT_MANAGER_AGENT_KEY } from "../agentAliases";

class CaptureOutput extends Writable {
  chunks: string[] = [];

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(String(chunk));
    callback();
  }

  text() {
    return this.chunks.join("");
  }
}

describe("cli agent run client", () => {
  // The compact tool trace renders localized action labels, so pin the locale
  // instead of inheriting the machine's LANG.
  beforeEach(() => {
    setCliLocale("en");
  });

  test("classifies only clear reviewer outcomes", () => {
    expect(classifyReviewDecisionStatus("Review decision: passed")).toBe("passed");
    expect(classifyReviewDecisionStatus("Review decision: needs_changes")).toBe("needs_changes");
    expect(classifyReviewDecisionStatus("Review decision: blocked")).toBe("blocked");
    expect(classifyReviewDecisionStatus("LGTM, no issues found")).toBe("passed");
    expect(classifyReviewDecisionStatus("Changes requested for missing test coverage")).toBe(
      "needs_changes"
    );
    expect(classifyReviewDecisionStatus("I looked at the diff and have notes")).toBeUndefined();
  });

  test("identifies server platform tools that local runtime cannot provide", () => {
    expect(findServerPlatformTools(["readFile", "queryTableRows", "updateTableRow"])).toEqual([
      "updateTableRow",
    ]);
    expect(findServerPlatformTools(["readFile", "queryTableRows"])).toEqual([]);
    expect(findServerPlatformTools(["readFile", "execShell"])).toEqual([]);
  });

  test("calls the Nolo HTTP API directly when AUTH_TOKEN is present", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ url: string; body: any; auth: string | null }> = [];

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      continueDialogId: "dialog-existing",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json({
          content: "hi",
          dialogId: "dialog-1",
          usage: { input_tokens: 2, output_tokens: 3 },
        });
      },
    });

    expect(requests).toEqual([
      {
        url: "https://nolo.chat/api/agent/run",
        auth: "Bearer token-123",
        body: {
          agentKey: "agent-pub-test",
          userInput: "hello",
          continueDialogId: "dialog-existing",
          runtimeContext: {
            surface: "cli",
            host: "terminal",
            runtime: "bun",
            entrypoint: "nolo-cli",
            capabilities: ["text-io", "streaming", "slash-commands"],
          },
          stream: true,
        },
      },
    ]);
    expect(result).toEqual({
      exitCode: 0,
      dialogId: "dialog-1",
      turnTokens: { input: 2, output: 3 },
    });
    expect(output.text()).toContain("nolo -> working");
    expect(output.text()).toContain("nolo > hi");
    expect(output.text()).not.toContain("tokens=");
  });

  test("prints agent run error details from failed HTTP responses", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "win-codex",
      agentKey: "agent-win-codex",
      serverUrl: "https://nolo.chat",
      message: "restart connector",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async () =>
        Response.json({
          error: "Connector execution failed",
          reason: "connector_execution_failed",
          code: "connector_disconnected_mid_run",
          message: "Connector disconnected for machine: machine-win",
          dialogId: "dialog-failed-1",
        }, { status: 502 }),
    });

    expect(result).toEqual({ exitCode: 1, dialogId: "dialog-failed-1" });
    expect(output.text()).toContain("[nolo] Agent request failed: HTTP 502");
    expect(output.text()).toContain("Connector execution failed");
    expect(output.text()).toContain("Connector disconnected for machine: machine-win");
    expect(output.text()).toContain("code=connector_disconnected_mid_run");
    expect(output.text()).toContain("reason=connector_execution_failed");
    expect(output.text()).toContain("[nolo] failed dialog: dialog-failed-1");
    expect(output.text()).toContain(
      'nolo agent run agent-win-codex --continue dialog-failed-1 --msg "retry"'
    );
  });

  test("falls back to non-streaming when a streaming HTTP run hits a gateway error", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    const result = await runAgentTurn({
      agentName: "app-builder",
      agentKey: "agent-pub-app-builder",
      serverUrl: "https://nolo.chat",
      message: "list my apps",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ body });
        if (requests.length === 1) {
          return Response.json({ error: "Bad gateway" }, { status: 502 });
        }
        return Response.json({
          content: "my-ai-consult-page-v2 | nolo-react | ssr",
          dialogId: "dialog-stream-fallback",
        });
      },
    });

    expect(requests.map((request) => request.body.stream)).toEqual([true, false]);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-stream-fallback" });
    expect(output.text()).toContain("streaming request returned HTTP 502");
    expect(output.text()).toContain("app-builder > my-ai-consult-page-v2 | nolo-react | ssr");
  });

  test("converts task evidence input to subjectRefs without retired orchestration payload", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-implementer",
      serverUrl: "https://nolo.chat",
      message: "Fix the filter UI",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      taskEvidence: {
        rowDbKey: "row-user-1-01TASK",
        artifactIds: ["artifact-1"],
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "ok", dialogId: "dialog-1" });
      },
    });

    expect(requests[0]?.body.userInput).toBe("Fix the filter UI");
    expectNoRetiredTaskOrchestrationTerms(JSON.stringify(requests[0]?.body.runtimeContext));
    expect(requests[0]?.body.runtimeContext.subjectRefs).toContainEqual({
      kind: "table-row",
      id: "row-user-1-01TASK",
      role: "task",
    });
    expect(requests[0]?.body.runtimeContext.subjectRefs).toContainEqual({
      kind: "artifact",
      id: "artifact-1",
      role: "evidence",
    });
  });

  test("does not write external completion state after an HTTP agent run returns a dialog", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "frontend-implementer",
      agentKey: "agent-frontend",
      serverUrl: "https://nolo.chat",
      message: "Fix the filter UI",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      taskEvidence: {
        rowDbKey: "row-user-1-01TASK",
      },
      fetchImpl: async () => {
        return Response.json({ content: "patched", dialogId: "dialog-1" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-1" });
  });

  test("sends image inputs as multimodal userInput over HTTP", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    await runAgentTurn({
      agentName: "vision",
      agentKey: "agent-pub-vision",
      serverUrl: "https://nolo.chat",
      message: "describe this",
      imageUrls: ["https://example.com/a.png"],
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "ok" });
      },
    });

    expect(requests[0]?.body.userInput).toEqual([
      { type: "text", text: "describe this" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });

  test("sends CLI dialog metadata over HTTP", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      spaceId: "space-1",
      category: "manual-checks",
      inheritedFromDialogKey: "dialog-user-1-dialog-2",
      parentDialogId: "dialog-2",
      subjectDialogKey: "01SUBJECTDIALOG",
      background: true,
      noStream: true,
      timeoutMs: 600000,
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ dialogId: "dialog-1", status: "queued" });
      },
    });

    expect(requests[0]?.body).toMatchObject({
      agentKey: "agent-pub-test",
      userInput: "hello",
      spaceId: "space-1",
      category: "manual-checks",
      inheritedFromDialogKey: "dialog-user-1-dialog-2",
      parentDialogId: "dialog-2",
      background: true,
      timeoutMs: 600000,
      stream: false,
    });
    expect(requests[0]?.body.runtimeContext.subjectRefs).toEqual([
      { kind: "dialog", id: "01SUBJECTDIALOG", role: "subject" },
    ]);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-1" });
  });

  test("sends explicit subject refs over HTTP for review evidence", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    await runAgentTurn({
      agentName: "reviewer",
      agentKey: "agent-reviewer",
      serverUrl: "https://nolo.chat",
      message: "Review this implementation",
      subjectRefs: [
        { kind: "table-row", id: "row-user-board-task", role: "subject" },
        { kind: "dialog", id: "dialog-impl", role: "review-target" },
        { kind: "external", id: "commit:abc123", role: "commit" },
      ],
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "queued", dialogId: "dialog-review" });
      },
    });

    expect(requests[0]?.body.runtimeContext.subjectRefs).toEqual([
      { kind: "table-row", id: "row-user-board-task", role: "subject" },
      { kind: "dialog", id: "dialog-impl", role: "review-target" },
      { kind: "external", id: "commit:abc123", role: "commit" },
    ]);
  });

  test("sends allowed child agent guard keys over HTTP runtime context", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    await runAgentTurn({
      agentName: "project-manager",
      agentKey: NOLO_PROJECT_MANAGER_AGENT_KEY,
      serverUrl: "https://nolo.chat",
      message: "Supervise child dispatch",
      allowedChildAgentKeys: ["fullstack"],
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "queued", dialogId: "dialog-pm" });
      },
    });

    expect(requests[0]?.body.runtimeContext.allowedChildAgentKeys).toEqual([
      "fullstack",
    ]);
  });

  test("sends allowed tool guard names over HTTP runtime context", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    await runAgentTurn({
      agentName: "project-manager",
      agentKey: NOLO_PROJECT_MANAGER_AGENT_KEY,
      serverUrl: "https://nolo.chat",
      message: "Supervise child dispatch",
      allowedToolNames: ["callAgent"],
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "queued", dialogId: "dialog-pm" });
      },
    });

    expect(requests[0]?.body.runtimeContext.allowedToolNames).toEqual([
      "callAgent",
    ]);
  });
  test("sends blocked tool guard names over HTTP runtime context", async () => {
    const output = new CaptureOutput();
    const requests: Array<{ body: any }> = [];

    await runAgentTurn({
      agentName: "project-manager",
      agentKey: NOLO_PROJECT_MANAGER_AGENT_KEY,
      serverUrl: "https://nolo.chat",
      message: "Review only, do not modify",
      blockedToolNames: ["writeFile", "editFile"],
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "queued", dialogId: "dialog-pm" });
      },
    });

    expect(requests[0]?.body.runtimeContext.blockedToolNames).toEqual([
      "writeFile",
      "editFile",
    ]);
  });

  test("does not write background handoff state", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "frontend-implementer",
      agentKey: "agent-frontend",
      serverUrl: "https://nolo.chat",
      message: "Fix settings style FOUC",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      background: true,
      noStream: true,
      taskEvidence: {
        rowDbKey: "row-user-1-01TASK",
      },
      output,
      fetchImpl: async () => {
        return Response.json({ dialogId: "dialog-bg", status: "pending" }, { status: 202 });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-bg" });
  });

  test("runs forced local turns through the injected runtime adapter without HTTP", async () => {
    const output = new CaptureOutput();
    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async (messages) => ({
            content: `local:${messages.at(-1)?.content}`,
            model: "fake-local",
            trace: messages,
          }),
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async () => {
        throw new Error("HTTP should not be called for forced local runs");
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-local" });
    expect(output.text()).toContain("frontend -> working locally");
    expect(output.text()).toContain("frontend > local:polish notifications");
  });

  test("persists task evidence subjectRefs on forced local turns", async () => {
    const output = new CaptureOutput();
    const savedTurns: any[] = [];

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      taskEvidence: {
        rowDbKey: "row-user-1-01TASK",
      },
      subjectRefs: [
        { kind: "dialog", id: "dialog-impl", role: "subject" },
      ],
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
        }),
        loadDialogHistory: async () => [],
        saveTurn: async (input) => {
          savedTurns.push(input);
          return { dialogId: "dialog-local" };
        },
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => ({ content: "done", model: "fake-local" }),
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async () => {
        throw new Error("HTTP should not be called for forced local runs");
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-local" });
    expect(savedTurns[0]?.runtimeContext?.subjectRefs).toEqual([
      { kind: "dialog", id: "dialog-impl", role: "subject" },
      { kind: "table-row", id: "row-user-1-01TASK", role: "task" },
    ]);
  });

  test("continues forced local tool loops until the provider returns final text", async () => {
    const output = new CaptureOutput();
    let completeCalls = 0;
    let toolCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "make screenshots",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["readFile"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-retry" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls <= 3) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: `call-${completeCalls}`,
                  type: "function",
                  function: { name: "readFile", arguments: "{}" },
                }],
              };
            }
            return { content: "done after retry", model: "fake-local" };
          },
        }),
        executeTool: async () => {
          toolCalls += 1;
          return { content: "ok" };
        },
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-local-retry" });
    expect(toolCalls).toBe(3);
    expect(output.text()).toContain("frontend > done after retry");
  });

  test("prints compact local tool trace by default", async () => {
    const output = new CaptureOutput();
    let completeCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "inspect repo",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["readFile"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls === 1) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-read",
                  type: "function",
                  function: { name: "readFile", arguments: JSON.stringify({ path: "README.md" }) },
                }],
              };
            }
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => ({ content: "clean" }),
      },
    });

    expect(result).toMatchObject({ exitCode: 0, dialogId: "dialog-local" });
    expect(output.text()).toContain("▸ Read README.md");
    expect(output.text()).toContain("✓");
    expect(output.text()).not.toContain("[nolo:tool]");
  });

  test("shows the active execShell command before the tool resolves", async () => {
    const output = new CaptureOutput();
    (output as CaptureOutput & { isTTY: boolean }).isTTY = true;
    let completeCalls = 0;
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });

    const run = runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "run tests",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["execShell"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-live-shell" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls === 1) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-shell",
                  type: "function",
                  function: {
                    name: "execShell",
                    arguments: JSON.stringify({ cmd: "bun test tui/session.test.ts" }),
                  },
                }],
              };
            }
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => {
          markToolStarted();
          await toolReleased;
          return { content: "1 pass\n", metadata: { exitCode: 0 } };
        },
      },
    });

    await toolStarted;
    expect(output.text()).toContain("Run bun test tui/session.test.ts");

    releaseTool();
    expect(await run).toMatchObject({ exitCode: 0, dialogId: "dialog-live-shell" });
  });

  test("restores the spinner for the next LLM round after hidden thinking and a tool", async () => {
    const output = new CaptureOutput();
    (output as CaptureOutput & { isTTY: boolean }).isTTY = true;
    let completeCalls = 0;
    let markSecondRoundStarted!: () => void;
    const secondRoundStarted = new Promise<void>((resolve) => {
      markSecondRoundStarted = resolve;
    });
    let releaseSecondRound!: () => void;
    const secondRoundReleased = new Promise<void>((resolve) => {
      releaseSecondRound = resolve;
    });

    const run = runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "run tests",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123", NOLO_CLI_THINKING: "hide" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["execShell"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-next-round-spinner" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async (_messages, providerOptions) => {
            completeCalls += 1;
            if (completeCalls === 1) {
              providerOptions?.onTextDelta?.(
                "<think>choose a command</think>I'll run the focused test."
              );
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-shell",
                  type: "function",
                  function: { name: "execShell", arguments: JSON.stringify({ cmd: "bun test" }) },
                }],
              };
            }
            markSecondRoundStarted();
            await secondRoundReleased;
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => ({
          content: "1 pass\n",
          metadata: { exitCode: 0 },
        }),
      },
    });

    await secondRoundStarted;
    const inFlightOutput = output.text();
    releaseSecondRound();
    expect(await run).toMatchObject({
      exitCode: 0,
      dialogId: "dialog-next-round-spinner",
    });

    const completedToolAt = inFlightOutput.lastIndexOf("✓");
    expect(completedToolAt).toBeGreaterThanOrEqual(0);
    expect(inFlightOutput.slice(completedToolAt)).toContain("working locally");
    expect(inFlightOutput).not.toContain("choose a command");
    expect(inFlightOutput).toContain("frontend > I'll run the focused test.\n");
  });

  test("prints verbose local tool trace when requested", async () => {
    const output = new CaptureOutput();
    let completeCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "inspect repo",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123", NOLO_CLI_TOOLS: "verbose" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["readFile"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-verbose" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls === 1) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-read",
                  type: "function",
                  function: { name: "readFile", arguments: JSON.stringify({ path: "README.md" }) },
                }],
              };
            }
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => ({ content: "clean" }),
      },
    });

    expect(result).toMatchObject({ exitCode: 0, dialogId: "dialog-local-verbose" });
    expect(output.text()).toContain("[nolo:tool] #1 -> readFile README.md");
    expect(output.text()).toContain("[nolo:tool] #1 <- readFile");
  });

  test("does not print local tool trace when disabled by env", async () => {
    const output = new CaptureOutput();
    let completeCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "inspect repo",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123", NOLO_TRACE_TOOLS: "0" },
      output,
      runtimeMode: "local",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["readFile"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-no-trace" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls === 1) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-read",
                  type: "function",
                  function: { name: "readFile", arguments: JSON.stringify({ path: "README.md" }) },
                }],
              };
            }
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => ({ content: "clean" }),
      },
    });

    expect(result).toMatchObject({ exitCode: 0, dialogId: "dialog-local-no-trace" });
    expect(output.text()).not.toContain("[nolo:tool]");
  });

  test("prints local tool events as jsonl when requested", async () => {
    const output = new CaptureOutput();
    let completeCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "inspect repo",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      eventsMode: "jsonl",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["execShell"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-jsonl" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls === 1) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-shell",
                  type: "function",
                  function: { name: "execShell", arguments: JSON.stringify({ command: "git status --short" }) },
                }],
              };
            }
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => ({ content: "stdout:\nclean\n\nexitCode: 0", metadata: { exitCode: 0 } }),
      },
    });

    expect(result).toMatchObject({ exitCode: 0, dialogId: "dialog-local-jsonl" });
    const events = output.text()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((event) => typeof event.type === "string" && event.type.startsWith("tool-"));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      type: "tool-call",
      round: 1,
      tool: "execShell",
      argsPreview: "git status --short",
    });
    expect(events[1]).toMatchObject({
      schemaVersion: 1,
      type: "tool-result",
      round: 1,
      tool: "execShell",
      summary: expect.stringContaining("exit=0"),
      metadata: { exitCode: 0 },
    });
  });

  test("does not pass local tool evidence to an external writeback path", async () => {
    const output = new CaptureOutput();
    let completeCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "inspect repo",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      taskEvidence: {
        rowDbKey: "row-user-1-01TASK",
      },
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
          toolNames: ["readFile"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            completeCalls += 1;
            if (completeCalls === 1) {
              return {
                content: "",
                model: "fake-local",
                tool_calls: [{
                  id: "call-read",
                  type: "function",
                  function: { name: "readFile", arguments: JSON.stringify({ path: "README.md" }) },
                }],
              };
            }
            return { content: "done", model: "fake-local" };
          },
        }),
        executeTool: async () => ({ content: "clean" }),
      },
    });

    expect(result).toMatchObject({ exitCode: 0, dialogId: "dialog-local" });
  });

  test("does not write local background handoff state", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "inspect repo in background",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "local",
      background: true,
      taskEvidence: {
        rowDbKey: "row-user-1-01TASK",
      },
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["local-provider", "local-persistence"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-bg" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => ({ content: "accepted locally", model: "fake-local" }),
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-local-bg" });
  });

  test("auto mode prefers a working local runtime before HTTP", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Frontend",
          prompt: "Fix UI",
          model: "fake-local",
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-auto-local" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => ({ content: "auto local ok", model: "fake-local" }),
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-auto-local" });
    expect(httpCalls).toEqual([]);
    expect(output.text()).toContain("frontend -> working locally");
  });

  test("auto mode refreshes missing local agent config and retries local once before HTTP", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let loadAgentConfigCalls = 0;
    let localCompletions = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "leveldb-persistence"],
        loadAgentConfig: async (agentRef) => {
          loadAgentConfigCalls += 1;
          if (loadAgentConfigCalls < 3) return null;
          return {
            key: agentRef,
            name: "Frontend",
            prompt: "Fix UI",
            model: "fake-local",
          };
        },
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-auto-local-retried" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            localCompletions += 1;
            return { content: "auto local after refresh", model: "fake-local" };
          },
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-auto-local-retried" });
    expect(loadAgentConfigCalls).toBe(4);
    expect(localCompletions).toBe(1);
    expect(httpCalls).toEqual([]);
    expect(output.text()).toContain("refreshing local config and retrying local once");
    expect(output.text().match(/working locally/g)?.length).toBe(2);
  });

  test("auto mode falls back to HTTP when local agent config is still missing after one refresh retry", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];
    let loadAgentConfigCalls = 0;

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "leveldb-persistence"],
        loadAgentConfig: async () => {
          loadAgentConfigCalls += 1;
          return null;
        },
        loadDialogHistory: async () => [],
        saveTurn: async () => {
          throw new Error("local runtime should not save when config is missing");
        },
        resolveProvider: async () => {
          throw new Error("local provider should not run when config is missing");
        },
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server fallback", dialogId: "dialog-server-fallback" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-server-fallback" });
    expect(loadAgentConfigCalls).toBe(3);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.body.agentKey).toBe("frontend-local");
    expect(output.text()).toContain("refreshing local config and retrying local once");
    expect(output.text()).toContain("frontend -> working");
    expect(output.text()).toContain("frontend > server fallback");
  });

  test("auto mode does not treat retired nolo frontend names as known platform agent aliases", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];
    let loadAgentConfigCalls = 0;

    const result = await runAgentTurn({
      agentName: "nolo-frontend",
      agentKey: "nolo-frontend",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "leveldb-persistence"],
        loadAgentConfig: async () => {
          loadAgentConfigCalls += 1;
          return null;
        },
        loadDialogHistory: async () => [],
        saveTurn: async () => {
          throw new Error("local runtime should not save when config is missing");
        },
        resolveProvider: async () => {
          throw new Error("local provider should not run when config is missing");
        },
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server fallback", dialogId: "dialog-server-fallback" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-server-fallback" });
    expect(loadAgentConfigCalls).toBe(3);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.body.agentKey).toBe("nolo-frontend");
    expect(output.text()).not.toContain("known platform agent");
    expect(output.text()).toContain("refreshing local config and retrying local once");
  });

  test("auto mode skips local runtime for agents that declare server platform tools", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];

    const result = await runAgentTurn({
      agentName: "pm",
      agentKey: "agent-custom-platform-tools",
      serverUrl: "https://nolo.chat",
      message: "write task rows",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "PM",
          prompt: "Manage task rows",
          model: "fake-local",
          toolNames: ["queryTableRows", "addTableRow", "updateTableRow"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => {
          throw new Error("local runtime should be skipped");
        },
        resolveProvider: async () => {
          throw new Error("local provider should be skipped");
        },
        executeTool: async () => {
          throw new Error("local tools should be skipped");
        },
      },
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server ok", dialogId: "dialog-server" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-server" });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.body.agentKey).toBe("agent-custom-platform-tools");
    expect(output.text()).toContain("auto runtime: skipping local runtime");
    expect(output.text()).toContain("addTableRow, updateTableRow");
    expect(output.text()).not.toContain("queryTableRows");
    expect(output.text()).toContain("pm -> working");
    expect(output.text()).toContain("pm > server ok");
  });

  test("auto mode keeps local runtime when only queryTableRows is declared", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let providerCalled = false;

    const result = await runAgentTurn({
      agentName: "minimax-m3",
      agentKey: "agent-minimax-m3",
      serverUrl: "https://nolo.chat",
      message: "query task rows",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "MiniMax M3",
          prompt: "Query task rows locally when needed.",
          provider: "custom",
          model: "MiniMax-M3",
          customProviderUrl: "https://api.minimaxi.com/v1",
          toolNames: ["queryTableRows"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-minimax-local" }),
        resolveProvider: async () => ({
          model: "MiniMax-M3",
          complete: async () => {
            providerCalled = true;
            return { content: "local minimax ok", model: "MiniMax-M3" };
          },
        }),
        executeTool: async () => ({ content: "[]" }),
      },
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server" });
      },
    });

    expect(providerCalled).toBe(true);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-minimax-local" });
    expect(httpCalls).toEqual([]);
    expect(output.text()).not.toContain("skipping local runtime");
    expect(output.text()).toContain("minimax-m3 -> working locally");
  });

  test("auto mode keeps local runtime for CLI provider agents even when they declare platform tools", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let providerCalled = false;

    const result = await runAgentTurn({
      agentName: "frontend-implementer",
      agentKey: "frontend-implementer",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "AGY",
          prompt: "Implement frontend tasks.",
          provider: "agy",
          cliProvider: "agy",
          toolNames: ["addTableRow", "queryTableRows"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-agy-auto-local" }),
        resolveProvider: async () => ({
          model: "agy",
          complete: async () => {
            providerCalled = true;
            return { content: "agy local ok", model: "agy" };
          },
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server" });
      },
    });

    expect(providerCalled).toBe(true);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-agy-auto-local" });
    expect(httpCalls).toEqual([]);
    expect(output.text()).not.toContain("skipping local runtime");
    expect(output.text()).toContain("frontend-implementer -> working locally");
    expect(output.text()).toContain("frontend-implementer > agy local ok");
  });

  test("auto mode does not skip fullstack when a local shell cwd is already bound", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let providerCalled = false;

    const result = await runAgentTurn({
      agentName: "fullstack",
      agentKey: "fullstack",
      serverUrl: "https://us.nolo.chat",
      message: "fix tests and commit",
      scriptDir: "C:/missing/scripts",
      env: {
        AUTH_TOKEN: "token-123",
      },
      output,
      runtimeMode: "auto",
      localRuntimeCwd: "/repo/.worktrees/nolo-agent-fullstack",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "fullstack",
          prompt: "Implement backend tasks.",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          toolNames: ["queryTableRows"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-fullstack-local" }),
        resolveProvider: async () => ({
          model: "deepseek-v4-flash",
          complete: async () => {
            providerCalled = true;
            return { content: "local fullstack ok", model: "deepseek-v4-flash" };
          },
        }),
        executeTool: async () => ({ content: "ok" }),
      },
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server" });
      },
    });

    expect(providerCalled).toBe(true);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-fullstack-local" });
    expect(httpCalls).toEqual([]);
    expect(output.text()).not.toContain("skipping local runtime");
    expect(output.text()).toContain("fullstack -> working locally");
  });

  test("auto mode skips local runtime for machine-bound localhost custom providers", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];

    const result = await runAgentTurn({
      agentName: "win-qwen",
      agentKey: "agent-win-qwen",
      serverUrl: "https://nolo.chat",
      message: "run on the bound Windows machine",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123", OPENAI_API_KEY: "local-provider-present" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Win Qwen",
          prompt: "Windows local model",
          provider: "custom",
          model: "qwen",
          customProviderUrl: "http://127.0.0.1:8080/v1/chat/completions",
          runtimeBinding: {
            machineId: "machine-win",
            ownerUserId: "user-1",
            connectorSurface: "cli",
          },
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => {
          throw new Error("local runtime should be skipped");
        },
        resolveProvider: async () => {
          throw new Error("local provider should be skipped");
        },
        executeTool: async () => {
          throw new Error("local tools should be skipped");
        },
      },
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server connector ok", dialogId: "dialog-win" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-win" });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.body.agentKey).toBe("agent-win-qwen");
    expect(output.text()).toContain("auto runtime: skipping local runtime");
    expect(output.text()).toContain("machine-bound localhost custom provider");
    expect(output.text()).not.toContain("win-qwen -> working locally");
  });

  test("auto mode runs a bound CLI agent locally when it is bound to the current machine", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let providerCalled = false;

    const result = await runAgentTurn({
      agentName: "mac-agy",
      agentKey: "agent-mac-agy",
      serverUrl: "https://us.nolo.chat",
      message: "run on this mac",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Mac AGY",
          prompt: "Use AGY on this Mac.",
          apiSource: "cli",
          cliProvider: "agy",
          runtimeBinding: { machineId: "machine-mac", ownerUserId: "user-1" },
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-mac-agy" }),
        resolveProvider: async () => ({
          model: "agy",
          complete: async () => {
            providerCalled = true;
            return { content: "local agy ok", model: "agy" };
          },
        }),
        executeTool: async () => ({ content: "[]" }),
      },
      currentMachineIdResolver: async () => "machine-mac",
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server should not run" });
      },
    });

    expect(providerCalled).toBe(true);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-local-mac-agy" });
    expect(httpCalls).toEqual([]);
    expect(output.text()).toContain("mac-agy -> working locally");
  });

  test("auto mode refreshes and runs an authenticated bound CLI agent locally without local env keys", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let loadAgentConfigCalls = 0;

    const result = await runAgentTurn({
      agentName: "agent-real-agy",
      agentKey: "agent-real-agy",
      serverUrl: "https://us.nolo.chat",
      message: "run local after refresh",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "leveldb-persistence"],
        loadAgentConfig: async (agentRef) => {
          loadAgentConfigCalls += 1;
          if (loadAgentConfigCalls === 1) return null;
          return {
            key: agentRef,
            name: "Real AGY",
            prompt: "Use AGY on this machine.",
            apiSource: "cli",
            cliProvider: "agy",
            runtimeBinding: { machineId: "machine-mac", ownerUserId: "user-1" },
          };
        },
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-refreshed-local" }),
        resolveProvider: async () => ({
          model: "agy",
          complete: async () => ({ content: "refreshed local agy ok", model: "agy" }),
        }),
        executeTool: async () => ({ content: "[]" }),
      },
      currentMachineIdResolver: async () => "machine-mac",
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server should not run" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-refreshed-local" });
    expect(loadAgentConfigCalls).toBeGreaterThanOrEqual(2);
    expect(httpCalls).toEqual([]);
    expect(output.text()).toContain("agent-real-agy -> working locally");
  });

  test("auto mode sends a bound CLI agent to the server when it is bound to another machine", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];

    const result = await runAgentTurn({
      agentName: "studio-agy",
      agentKey: "agent-studio-agy",
      serverUrl: "https://us.nolo.chat",
      message: "run on the studio",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Studio AGY",
          prompt: "Use AGY on the Studio.",
          apiSource: "cli",
          cliProvider: "agy",
          runtimeBinding: { machineId: "machine-studio", ownerUserId: "user-1" },
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => {
          throw new Error("local runtime should be skipped");
        },
        resolveProvider: async () => {
          throw new Error("local provider should be skipped");
        },
        executeTool: async () => {
          throw new Error("local tools should be skipped");
        },
      },
      currentMachineIdResolver: async () => "machine-mac",
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server connector ok", dialogId: "dialog-studio" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-studio" });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.url).toBe("https://us.nolo.chat/api/agent/run");
    expect(httpCalls[0]?.body.agentKey).toBe("agent-studio-agy");
    expect(output.text()).toContain("bound to machine-studio");
    expect(output.text()).not.toContain("studio-agy -> working locally");
  });

  test.each(["copilot", "gemini", "codex", "claude", "agy", "qoder", "opencode", "grok", "kimi"])(
    "auto mode treats provider-only %s CLI records as machine-bound CLI agents",
    async (provider) => {
      const output = new CaptureOutput();
      const httpCalls: Array<{ url: string; body: any }> = [];

      const result = await runAgentTurn({
        agentName: `${provider}-agent`,
        agentKey: `agent-${provider}`,
        serverUrl: "https://us.nolo.chat",
        message: `run ${provider} on the bound machine`,
        scriptDir: "C:/missing/scripts",
        env: { AUTH_TOKEN: "token-123" },
        output,
        runtimeMode: "auto",
        localRuntimeAdapter: {
          host: "cli",
          capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
          loadAgentConfig: async (agentRef) => ({
            key: agentRef,
            name: `${provider} agent`,
            prompt: `Use ${provider} on the bound machine.`,
            provider,
            runtimeBinding: { machineId: "machine-studio", ownerUserId: "user-1" },
          }),
          loadDialogHistory: async () => [],
          saveTurn: async () => {
            throw new Error("local runtime should be skipped");
          },
          resolveProvider: async () => {
            throw new Error("local provider should be skipped");
          },
          executeTool: async () => {
            throw new Error("local tools should be skipped");
          },
        },
        currentMachineIdResolver: async () => "machine-mac",
        fetchImpl: async (url, init) => {
          httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({ content: "server connector ok", dialogId: `dialog-${provider}` });
        },
      });

      expect(result).toEqual({ exitCode: 0, dialogId: `dialog-${provider}` });
      expect(httpCalls).toHaveLength(1);
      expect(httpCalls[0]?.url).toBe("https://us.nolo.chat/api/agent/run");
      expect(httpCalls[0]?.body.agentKey).toBe(`agent-${provider}`);
      expect(output.text()).toContain("bound to machine-studio");
      expect(output.text()).not.toContain(`${provider}-agent -> working locally`);
    }
  );

  test("auto mode keeps builtin nolo on local runtime so CLI workspace tools are available", async () => {
    const output = new CaptureOutput();
    const httpCalls: string[] = [];
    let providerCalled = false;

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: BUILTIN_NOLO_AGENT_KEY,
      serverUrl: "https://nolo.chat",
      message: "帮我总结最近 10 个对话",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async () => ({
          key: BUILTIN_NOLO_AGENT_KEY,
          name: "nolo",
          prompt: "Use workspace tools.",
          model: "fake-local",
          toolNames: ["queryTableRows", "addTableRow", "updateTableRow"],
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-builtin-nolo-local" }),
        resolveProvider: async () => ({
          model: "fake-local",
          complete: async () => {
            providerCalled = true;
            return { content: "local nolo with tools", model: "fake-local" };
          },
        }),
        executeTool: async () => ({ content: "[]" }),
      },
      fetchImpl: async (url) => {
        httpCalls.push(String(url));
        return Response.json({ content: "server" });
      },
    });

    expect(providerCalled).toBe(true);
    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-builtin-nolo-local" });
    expect(httpCalls).toEqual([]);
    expect(output.text()).not.toContain("skipping local runtime");
    expect(output.text()).toContain("nolo -> working locally");
  });

  test("auto mode skips local runtime for server platform tools declared by runtime policy", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];

    const result = await runAgentTurn({
      agentName: "pm",
      agentKey: "agent-policy-platform-tools",
      serverUrl: "https://nolo.chat",
      message: "query task rows",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "PM",
          prompt: "Manage task rows",
          model: "fake-local",
          runtimeToolPolicy: {
            version: 1,
            agentTools: ["queryTableRows", "addTableRow"],
            runtimeTools: ["execShell"],
          },
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => {
          throw new Error("local runtime should be skipped");
        },
        resolveProvider: async () => {
          throw new Error("local provider should be skipped");
        },
        executeTool: async () => {
          throw new Error("local tools should be skipped");
        },
      },
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server ok", dialogId: "dialog-server-policy" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-server-policy" });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.body.agentKey).toBe("agent-policy-platform-tools");
    expect(output.text()).toContain("auto runtime: skipping local runtime");
    expect(output.text()).toContain("addTableRow");
    expect(output.text()).not.toContain("queryTableRows");
  });

  test("auto mode skips known platform agents when local config cannot be read", async () => {
    const output = new CaptureOutput();
    const httpCalls: Array<{ url: string; body: any }> = [];

    const result = await runAgentTurn({
      agentName: "nolo-project-manager",
      agentKey: NOLO_PROJECT_MANAGER_AGENT_KEY,
      serverUrl: "https://us.nolo.chat",
      message: "write task rows",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123", OPENAI_API_KEY: "local-provider-present" },
      output,
      runtimeMode: "auto",
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider", "local-tools"],
        loadAgentConfig: async () => {
          throw new Error("Database failed to open: LOCK");
        },
        loadDialogHistory: async () => {
          throw new Error("local runtime should be skipped");
        },
        saveTurn: async () => {
          throw new Error("local runtime should be skipped");
        },
        resolveProvider: async () => {
          throw new Error("local provider should be skipped");
        },
        executeTool: async () => {
          throw new Error("local tools should be skipped");
        },
      },
      fetchImpl: async (url, init) => {
        httpCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ content: "server ok", dialogId: "dialog-server" });
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-server" });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.body.agentKey).toBe(NOLO_PROJECT_MANAGER_AGENT_KEY);
    expect(output.text()).toContain("known platform agent");
    expect(output.text()).toContain("nolo-project-manager -> working");
    expect(output.text()).toContain("nolo-project-manager > server ok");
  });

  test("builds the default local adapter when env requests local mode", async () => {
    const output = new CaptureOutput();
    const builtModes: string[] = [];

    const result = await runAgentTurn({
      agentName: "frontend",
      agentKey: "frontend-local",
      serverUrl: "https://nolo.chat",
      message: "polish notifications",
      scriptDir: "C:/missing/scripts",
      env: { NOLO_RUNTIME_MODE: "local" },
      output,
      localRuntimeAdapterFactory: (env) => {
        builtModes.push(env.NOLO_RUNTIME_MODE ?? "");
        return {
          host: "cli",
          capabilities: ["local-provider", "local-persistence"],
          loadAgentConfig: async (agentRef) => ({ key: agentRef, prompt: "Fix UI" }),
          loadDialogHistory: async () => [],
          saveTurn: async () => ({ dialogId: "dialog-local-env" }),
          resolveProvider: async () => ({
            model: "fake-local",
            complete: async () => ({ content: "local env ok", model: "fake-local" }),
          }),
          executeTool: async () => {
            throw new Error("no tools expected");
          },
        };
      },
      fetchImpl: async () => {
        throw new Error("HTTP should not be called for env local runs");
      },
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-local-env" });
    expect(builtModes).toEqual(["local"]);
    expect(output.text()).toContain("frontend -> working locally");
  });

  test("streams agent text responses to terminal output", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async () =>
        new Response(
          [
            `data: ${JSON.stringify({ type: "text", content: "你" })}`,
            "",
            `data: ${JSON.stringify({ type: "text", content: "好" })}`,
            "",
            `data: ${JSON.stringify({ type: "done", dialogId: "dialog-stream" })}`,
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        ),
    });

    expect(result).toEqual({ exitCode: 0, dialogId: "dialog-stream" });
    expect(output.text()).toContain("nolo -> working");
    expect(output.text()).toContain("nolo > 你好");
  });

  test("returns a recoverable dialog when a server stream drops after dialog creation", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async () => {
        let sent = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              const encoder = new TextEncoder();
              if (!sent) {
                sent = true;
                controller.enqueue(
                  encoder.encode(
                    [
                      `data: ${JSON.stringify({
                        type: "dialog",
                        dialogId: "dialog-recoverable",
                        status: "running",
                      })}`,
                      "",
                      `data: ${JSON.stringify({ type: "text", content: "partial" })}`,
                      "",
                    ].join("\n")
                  )
                );
                return;
              }
              controller.error(new Error("socket closed"));
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      dialogId: "dialog-recoverable",
      streamInterrupted: true,
    });
    expect(output.text()).toContain("dialog dialog-recoverable was created");
    expect(output.text()).toContain("read the dialog before retrying");
  });

  test("prints an auth hint when installed without repo scripts or AUTH_TOKEN", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      scriptDir: "C:/missing/scripts",
      env: {},
      output,
      runtimeMode: "server",
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(output.text()).toContain("Run `nolo login`");
  });

  test("auto mode does not fall back to server without an auth token", async () => {
    const output = new CaptureOutput();
    let fetchCalls = 0;

    const result = await runAgentTurn({
      agentName: "local-bot",
      agentKey: "agent-local-01AGENT",
      serverUrl: "https://nolo.chat",
      message: "hello local",
      scriptDir: "C:/missing/scripts",
      env: {},
      runtimeMode: "auto",
      output,
      localRuntimeAdapter: {
        host: "cli",
        capabilities: ["leveldb-agent-config", "local-provider"],
        loadAgentConfig: async (agentRef) => ({
          key: agentRef,
          name: "Local",
          apiSource: "custom",
          customProviderUrl: "http://127.0.0.1:11434/v1",
          model: "local-model",
        }),
        loadDialogHistory: async () => [],
        saveTurn: async () => ({ dialogId: "dialog-local-no-auth" }),
        resolveProvider: async () => ({
          model: "local-model",
          complete: async () => {
            throw new Error("local provider offline");
          },
        }),
        executeTool: async () => {
          throw new Error("no tools expected");
        },
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not be called without auth token");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(output.text()).toContain("server fallback is disabled");
    expect(output.text()).not.toContain("falling back to server");
  });

  test("prints a friendly connection hint instead of crashing on transport errors", async () => {
    const output = new CaptureOutput();

    const result = await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "http://127.0.0.1:38123",
      message: "hello",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      output,
      runtimeMode: "server",
      fetchImpl: async () => {
        throw new Error("ConnectionRefused");
      },
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(output.text()).toContain("Could not reach http://127.0.0.1:38123/api/agent/run");
    expect(output.text()).toContain("set NOLO_SERVER");
  });

  test("server turn spinner takes over the terminal cursor in TTY mode and shows elapsed time", async () => {
    const output = new CaptureOutput();
    (output as any).isTTY = true;

    await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async () =>
        Response.json({
          content: "hi",
          dialogId: "dialog-1",
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
    });

    const text = output.text();
    expect(text).toContain("\x1b[?25l");
    expect(text).toContain("\x1b[?25h");
    expect(text).toContain("nolo -> working (0s)");
    expect(text).not.toContain("nolo -> working...");
  });

  test("non-TTY server turn does not emit cursor control sequences", async () => {
    const output = new CaptureOutput();
    (output as any).isTTY = false;

    await runAgentTurn({
      agentName: "nolo",
      agentKey: "agent-pub-test",
      serverUrl: "https://nolo.chat",
      message: "hello",
      scriptDir: "C:/missing/scripts",
      env: { AUTH_TOKEN: "token-123" },
      runtimeMode: "server",
      output,
      fetchImpl: async () =>
        Response.json({
          content: "hi",
          dialogId: "dialog-1",
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
    });

    const text = output.text();
    expect(text).not.toContain("\x1b[?25l");
    expect(text).not.toContain("\x1b[?25h");
    expect(text).toContain("nolo -> working");
    expect(text).not.toContain("nolo -> working...");
  });
});
