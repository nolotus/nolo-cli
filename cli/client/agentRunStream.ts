import { toErrorMessage } from "../../core/errorMessage";
import { createSseToolEventAdapter } from "./toolOutput";
import { buildTurnTokenUsage, formatUsage, shouldShowUsage } from "./tokenUsage";
import { Spinner } from "./agentRunSpinner";
import { createCliTurnOutput } from "./agentRunOutput";
import type { RunAgentTurnOptions, RunAgentTurnResult } from "./agentRunTypes";

/**
 * 读取 agent run 的 SSE 流并渲染到终端。Esc-to-stop 兜底：
 * abortSignal 触发后立刻 cancel reader，让 reader.read() 循环不用等
 * 下一个 SSE chunk 到达就返回/抛错，避免"按 Esc 后仍要等一会"。
 */
export async function readStreamingAgentRun(
  options: RunAgentTurnOptions,
  res: Response,
  existingSpinner: Spinner | undefined,
): Promise<RunAgentTurnResult> {
  const reader = res.body?.getReader();
  if (!reader) {
    existingSpinner?.stop();
    options.output.write(
      "[nolo] Agent stream response did not include a readable body.\n",
    );
    return { exitCode: 1 };
  }

  // Esc-to-stop 的即时兜底：abortSignal 触发后立刻 cancel reader，
  // 让下面 reader.read() 循环不用等下一个 SSE chunk 到达就返回/抛错。
  // 否则用户按 Esc 后仍要等到上游推送下一条事件才会退出"等一会"。
  options.abortSignal?.addEventListener(
    "abort",
    () => {
      reader.cancel("user-stop").catch(() => {});
    },
    { once: true },
  );

  const decoder = new TextDecoder();
  const turnOutput = createCliTurnOutput({
    options,
    workingLabel: `${options.agentName} -> working`,
    spinner: existingSpinner,
  });

  const sseAdapter = createSseToolEventAdapter((evt) => {
    turnOutput.handleToolEvent(evt);
  });

  let buffer = "";
  let content = "";
  let dialogId: string | undefined;
  let usage: any;

  const handlePayload = (payload: any) => {
    if (typeof payload?.dialogId === "string" && payload.dialogId.trim()) {
      dialogId = payload.dialogId;
    }
    if (payload?.error || payload?.type === "error") {
      throw new Error(
        String(payload.error || payload.message || "Agent stream failed"),
      );
    }
    if (payload?.type === "done") {
      usage = payload.usage;
      return;
    }
    if (payload?.type === "dialog" || payload?.type === "status") {
      return;
    }
    if (payload?.type === "turn_warning") {
      // Silence turn_warning SSE events because their fallback/explanatory content
      // arrives as standard text events; displaying both would create noisy duplicate warnings.
      return;
    }
    if (payload?.type === "thinking") {
      const thinkChunk =
        typeof payload.content === "string"
          ? payload.content
          : typeof payload.chunk === "string"
            ? payload.chunk
            : "";
      if (thinkChunk) {
        turnOutput.pushThinking(thinkChunk);
      }
      return;
    }
    if (payload?.type === "tool_start") {
      sseAdapter.onToolStart(payload.calls ?? payload);
      return;
    }
    if (payload?.type === "tool_result") {
      sseAdapter.onToolResult(payload);
      return;
    }
    if (payload?.type === "tool_end") {
      sseAdapter.onToolEnd();
      turnOutput.showWorking();
      return;
    }
    const chunk =
      payload?.type === "text"
        ? payload.content
        : typeof payload?.chunk === "string"
          ? payload.chunk
          : "";
    if (!chunk) return;
    content += chunk;
    turnOutput.pushText(chunk);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const dataLines = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter(Boolean);
        for (const raw of dataLines) {
          handlePayload(JSON.parse(raw));
        }
      }
    }
    if (buffer.trim()) {
      const raw = buffer
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (raw) handlePayload(JSON.parse(raw));
    }
  } catch (error) {
    turnOutput.spinner.stop();
    if (options.abortSignal?.aborted) {
      // User-initiated stop; the server may still finish the dialog.
      return {
        exitCode: 0,
        ...(dialogId ? { dialogId } : {}),
        streamInterrupted: true,
      };
    }
    const message = toErrorMessage(error);
    if (dialogId) {
      options.output.write(
        `\n[nolo] Agent stream transport interrupted after dialog ${dialogId} was created: ${message}\n`,
      );
      options.output.write(
        "[nolo] The agent run may still finish on the server; read the dialog before retrying.\n",
      );
      return { exitCode: 0, dialogId, streamInterrupted: true };
    }
    options.output.write(`\n[nolo] Agent stream failed: ${message}\n`);
    return { exitCode: 1 };
  }

  turnOutput.finish(content);
  const usageText = formatUsage(usage, dialogId);
  if (usageText && shouldShowUsage(options.env))
    options.output.write(`${usageText}\n`);
  return {
    exitCode: 0,
    ...(dialogId ? { dialogId } : {}),
    turnTokens: buildTurnTokenUsage(usage, options.agentKey),
  };
}