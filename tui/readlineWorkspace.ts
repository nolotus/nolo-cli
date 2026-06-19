import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import { compactDialog, type CompactDialogResult } from "../client/compactDialog";
import { saveProfileAgentSelection } from "../client/profileConfig";
import { readPipeText, spawnProcess } from "../processSpawn";
import { runSelfUpdate } from "../updateCommands";
import { formatAgentSwitchMessage, runAgentPicker } from "./agentPicker";
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

async function runAgentChat(
  scriptDir: string,
  state: TuiState,
  message: string,
  env: NodeJS.ProcessEnv,
  output: NodeJS.WritableStream,
  agentRunner: typeof runAgentTurn = runAgentTurn
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
  });
  return result;
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
        const runResult = await runAgentChat(
          options.scriptDir,
          state,
          result.action.message,
          options.env ?? process.env,
          output,
          options.agentRunner
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

      output.write(`\n${renderStatusLine(state)}\n`);
      rl.setPrompt(renderPrompt(state));
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}
