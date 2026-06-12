import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import { compactDialog, type CompactDialogResult } from "../client/compactDialog";
import { runSelfUpdate } from "../updateCommands";
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
    scriptDir,
    env,
    output,
  });
  return result;
}

async function pipeReadableToOutput(
  readable: ReadableStream<Uint8Array> | null,
  output: NodeJS.WritableStream
) {
  if (!readable) return;
  const text = await new Response(readable).text();
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
  const proc = Bun.spawn({
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
      const result = handleTuiInput(line, state);
      state = result.nextState;

      if (result.output) {
        output.write(`${result.output}\n`);
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
            output.write("Update failed. Fix the npm error above, then run /update again or use nolo update.\n");
          }
        } catch (error) {
          output.write(`${error instanceof Error ? error.message : String(error)}\n`);
          output.write("Update failed. Fix the npm error above, then run /update again or use nolo update.\n");
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
        if (runResult.dialogId) {
          state = {
            ...state,
            dialogId: runResult.dialogId,
            dialogLabel: runResult.dialogId,
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
