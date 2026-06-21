import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import type { LocalAgentActionGate } from "../agent-runtime/localLoop";
import { readCommandActionGatePayload } from "../agent-runtime/actionGate";
import type { AgentRuntimeToolResult } from "../agentRuntimeLocal";
import { compactDialog, type CompactDialogResult } from "../client/compactDialog";
import { saveProfileAgentSelection } from "../client/profileConfig";
import { readPipeText, spawnProcess } from "../processSpawn";
import { runSelfUpdate } from "../updateCommands";
import { formatAgentSwitchMessage, runAgentPicker } from "./agentPicker";
import { mergeAttachedImages, readImagePaths, resolveImageSource, summarizeAttachment } from "./pasteImage";
import {
  createInitialTuiState,
  handleTuiInput,
  renderPrompt,
  renderStatusLine,
  renderWelcome,
  type TuiState,
} from "./session";

export type SelfUpdater = (
  output: NodeJS.WritableStream
) => Promise<number>;

type WorkspaceOptions = {
  scriptDir: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  cliEntrypointPath?: string;
  agentRunner?: typeof runAgentTurn;
  cliCommandRunner?: CliCommandRunner;
  compactRunner?: (options: {
    serverUrl: string;
    authToken: string;
    dialogId: string;
  }) => Promise<CompactDialogResult>;
  selfUpdater?: SelfUpdater;
  spawnRunner?: typeof spawnProcess;
};

type CliCommandRunner = (
  args: string[],
  context: {
    env: NodeJS.ProcessEnv;
    output: NodeJS.WritableStream;
    scriptDir: string;
    cliEntrypointPath: string;
  }
) => Promise<number>;

type RawModeInput = NodeJS.ReadableStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

async function runAgentChat(
  scriptDir: string,
  state: TuiState,
  message: string,
  env: NodeJS.ProcessEnv,
  output: NodeJS.WritableStream,
  agentRunner: typeof runAgentTurn = runAgentTurn,
  options: {
    imageUrls?: string[];
    actionGateHandler?: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>;
  } = {}
) {
  const result: RunAgentTurnResult = await agentRunner({
    agentName: state.agentName,
    agentKey: state.agentKey,
    serverUrl: state.serverUrl,
    message,
    continueDialogId: state.dialogId,
    runtimeMode: state.runtimeMode,
    localRuntimeCwd: process.cwd(),
    scriptDir,
    env: {
      ...env,
      NOLO_CLI_THINKING: state.thinkingDisplay,
      NOLO_CLI_TOOLS: state.toolDisplay,
      NOLO_CLI_RENDER: state.renderDisplay,
    },
    output,
    ...(options.imageUrls && options.imageUrls.length > 0
      ? { imageUrls: options.imageUrls }
      : {}),
    ...(options.actionGateHandler ? { actionGateHandler: options.actionGateHandler } : {}),
  });
  return result;
}

function waitForActionGate(
  rl: ReturnType<typeof createInterface>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  gate: LocalAgentActionGate,
  spawnRunner: typeof spawnProcess,
): Promise<AgentRuntimeToolResult> {
  const commandPayload = gate.kind === "handoff"
    ? readCommandActionGatePayload(gate.payload)
    : null;
  const displayCommand = commandPayload?.displayCommand ?? commandPayload?.command.join(" ") ?? gate.title;
  output.write("\n[nolo] Action needed in your terminal\n");
  output.write(`[nolo] ${gate.title}\n`);
  if (gate.body) output.write(`[nolo] ${gate.body}\n`);
  output.write(`  ${displayCommand}\n`);
  output.write("[nolo] Press Enter to run it now. Follow any prompts below, or Ctrl+C to cancel.\n");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AgentRuntimeToolResult) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      rl.off("SIGINT", onSigint);
      resolve(result);
    };
    const cancelResult = (reason: string): AgentRuntimeToolResult => ({
      content: `action gate cancelled: ${gate.title}`,
      metadata: {
        exitCode: 130,
        actionGateResult: { gateId: gate.id, status: "cancelled", output: reason },
      },
    });
    const failResult = (message: string): AgentRuntimeToolResult => ({
      content: `action gate failed: ${gate.title}`,
      metadata: {
        exitCode: 1,
        actionGateResult: { gateId: gate.id, status: "failed", output: message },
      },
    });
    const onClose = () => finish(cancelResult("readline closed"));
    const onSigint = () => finish(cancelResult("interrupted"));
    rl.once("close", onClose);
    rl.once("SIGINT", onSigint);
    rl.question("", async () => {
      if (settled) return;
      if (!commandPayload) {
        finish(failResult("unsupported gate payload"));
        return;
      }
      const rawInput = input as RawModeInput;
      const restoreRawMode = Boolean(rawInput.isRaw);
      rl.pause();
      rawInput.setRawMode?.(false);
      let exitCode = 1;
      let errorMessage = "";
      try {
        const proc = spawnRunner({
          cmd: commandPayload.command,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        exitCode = await proc.exited;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        if (restoreRawMode) rawInput.setRawMode?.(true);
        rl.resume();
      }
      finish({
        content: exitCode === 0 && !errorMessage
          ? `action gate completed: ${displayCommand}`
          : errorMessage
            ? `action gate failed: ${errorMessage}`
            : `action gate failed with exit code ${exitCode}: ${displayCommand}`,
        metadata: {
          exitCode,
          actionGateResult: {
            gateId: gate.id,
            status: exitCode === 0 && !errorMessage ? "completed" : "failed",
            output: errorMessage || displayCommand,
          },
          argv: commandPayload.command,
          displayCommand,
        },
      });
    });
  });
}

async function pipeReadableToOutput(
  stream: Readable | null,
  output: NodeJS.WritableStream
) {
  const text = await readPipeText(stream);
  if (text) output.write(text);
}

function resolveDefaultCliEntrypoint(scriptDir: string) {
  if (process.argv[1]) return process.argv[1];
  return join(scriptDir, "..", "packages", "cli", "index.ts");
}

async function runCliCommandInChildProcess(
  args: string[],
  context: {
    env: NodeJS.ProcessEnv;
    output: NodeJS.WritableStream;
    cliEntrypointPath: string;
  }
) {
  const proc = spawnProcess({
    cmd: [process.execPath, context.cliEntrypointPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: context.env,
  });
  await Promise.all([
    pipeReadableToOutput(proc.stdout, context.output),
    pipeReadableToOutput(proc.stderr, context.output),
  ]);
  return proc.exited;
}

function persistAgentSelection(
  state: TuiState,
  env: NodeJS.ProcessEnv | undefined
) {
  try {
    saveProfileAgentSelection({
      agentKey: state.agentKey,
      agentName: state.agentName,
    });
  } catch {
    // profile persistence is best-effort in the workspace loop
  }
  if (env) {
    env.NOLO_AGENT = state.agentKey;
    env.NOLO_AGENT_NAME = state.agentName;
  }
}

export async function startTuiWorkspace(options: WorkspaceOptions) {
  let state = createInitialTuiState(options.env ?? process.env);
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const cliEntrypointPath =
    options.cliEntrypointPath ?? resolveDefaultCliEntrypoint(options.scriptDir);
  const cliCommandRunner = options.cliCommandRunner ?? runCliCommandInChildProcess;
  const spawnRunner = options.spawnRunner ?? spawnProcess;
  const selfUpdater: SelfUpdater =
    options.selfUpdater ?? ((target) => runSelfUpdate({ output: target }));
  const rl = createInterface({ input, output });

  output.write(renderWelcome(state));
  rl.setPrompt(renderPrompt(state));
  rl.prompt();

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      const result = handleTuiInput(line, state);
      const previousAgentKey = state.agentKey;
      state = result.nextState;

      if (result.output) {
        output.write(`${result.output}\n`);
      }

      if (
        state.agentKey !== previousAgentKey &&
        result.output?.startsWith("Switched to ")
      ) {
        persistAgentSelection(state, options.env ?? process.env);
      }

      if (result.action?.type === "exit") {
        break;
      }

      if (result.action?.type === "compact") {
        const runner = options.compactRunner ?? compactDialog;
        const authToken =
          options.env?.AUTH_TOKEN ?? options.env?.AUTH ?? options.env?.BENCHMARK_AUTH_TOKEN ?? "";
        try {
          const compactResult = await runner({
            serverUrl: state.serverUrl,
            authToken,
            dialogId: result.action.dialogId,
          });
          state = {
            ...state,
            dialogId: compactResult.dialogId,
            dialogLabel: compactResult.dialogId,
          };
        } catch (error: any) {
          output.write(
            `[nolo] Compact failed: ${error?.message ?? String(error)}\n`
          );
        }
      }

      if (result.action?.type === "self-update") {
        try {
          const exitCode = await selfUpdater(output);
          if (exitCode === 0) {
            output.write("Update finished. Restart nolo to use the new version.\n");
          } else {
            output.write("Update failed. Check the error above, then run /update again or use nolo update.\n");
          }
        } catch (error) {
          output.write(`${error instanceof Error ? error.message : String(error)}\n`);
          output.write("Update failed. Check the error above, then run /update again or use nolo update.\n");
        }
      }

      if (result.action?.type === "pick-agent") {
        rl.pause();
        try {
          const pickResult = await runAgentPicker({
            currentKey: state.agentKey,
            env: options.env ?? process.env,
            input: input as NodeJS.ReadStream,
            output: output as NodeJS.WritableStream,
          });
          if (pickResult.kind === "list") {
            output.write(`${pickResult.output}\n`);
          } else if (pickResult.kind === "selected") {
            state = {
              ...state,
              agentName: pickResult.name,
              agentKey: pickResult.key,
            };
            persistAgentSelection(state, options.env ?? process.env);
            output.write(
              `${formatAgentSwitchMessage({
                name: pickResult.name,
                dialogId: state.dialogId,
              })}\n`
            );
          } else {
            output.write("Agent switch cancelled.\n");
          }
        } catch (error) {
          output.write(
            `[nolo] Agent picker failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
        } finally {
          rl.resume();
        }
      }

      if (result.action?.type === "list-agents") {
        try {
          const pickResult = await runAgentPicker({
            currentKey: state.agentKey,
            env: options.env ?? process.env,
            input: input as NodeJS.ReadStream,
            output: output as NodeJS.WritableStream,
            interactive: false,
          });
          if (pickResult.kind === "list") {
            output.write(`${pickResult.output}\n`);
          }
        } catch (error) {
          output.write(
            `[nolo] Agent list failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      }

      if (result.action?.type === "cli-command") {
        try {
          const exitCode = await cliCommandRunner(result.action.args, {
            env: options.env ?? process.env,
            output,
            scriptDir: options.scriptDir,
            cliEntrypointPath,
          });
          if (exitCode !== 0) {
            output.write(`[nolo] CLI command exited with code ${exitCode}.\n`);
          }
        } catch (error) {
          output.write(
            `[nolo] CLI command failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      }

      if (result.action?.type === "chat") {
        const pathsToRead = [
          ...(result.action.imagePaths ?? []),
          ...state.attachedImages.map((img) => img.sourcePath),
        ];
        let imageUrls: string[] = [];
        if (pathsToRead.length > 0) {
          const readResult = await readImagePaths(pathsToRead, {
            onFailure: (_path, err) =>
              output.write(`[nolo] image skipped: ${err.message}\n`),
          });
          imageUrls = readResult.images.map((img) => img.dataUrl);
          if (readResult.images.length > 0) {
            state = {
              ...state,
              attachedImages: mergeAttachedImages(state.attachedImages, readResult.images),
            };
          }
        }

        const runResult = await runAgentChat(
          options.scriptDir,
          state,
          result.action.message,
          options.env ?? process.env,
          output,
          options.agentRunner,
          {
            ...(imageUrls.length > 0 ? { imageUrls } : {}),
            actionGateHandler: (gate) =>
              waitForActionGate(rl, input, output, gate, spawnRunner),
          }
        );
        if (runResult.dialogId || runResult.turnTokens) {
          state = {
            ...state,
            ...(runResult.dialogId
              ? {
                  dialogId: runResult.dialogId,
                  dialogLabel: runResult.dialogId,
                }
              : {}),
            ...(runResult.turnTokens ? { turnTokens: runResult.turnTokens } : {}),
          };
        }
      }

      if (result.action?.type === "attach-images") {
        const readResult = await readImagePaths(result.action.paths, {
          resolve: (raw) => resolveImageSource(raw, state.cwd),
          onSuccess: (img) => output.write(`${summarizeAttachment(img)}\n`),
          onFailure: (_path, err) =>
            output.write(`[nolo] image skipped: ${err.message}\n`),
        });
        if (readResult.images.length > 0) {
          state = {
            ...state,
            attachedImages: mergeAttachedImages(state.attachedImages, readResult.images),
          };
        }
      }

      output.write(`\n${renderStatusLine(state)}\n`);
      rl.setPrompt(renderPrompt(state));
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}
