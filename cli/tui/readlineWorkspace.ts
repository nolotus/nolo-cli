import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import { resolveSkillReference, buildSkillContextBlocks } from "../agentRunPrompts";
import {
  classifyCliAutoRoute,
  CLI_AUTO_TIER_AGENT_KEY_TABLE,
  CLI_IMAGE_AGENT_KEY,
} from "../client/autoModelRouter";
import {
  buildModelLayerOverride,
  type ModelLayerOverride,
} from "../../agent-runtime/modelLayerOverride";
import { readDbRecord } from "../agentRecordHelpers";
import { resolveAgentImageInputSupport, type AgentCapabilityConfig } from "../../ai/llm/agentCapabilities";
import type { LocalAgentActionGate } from "../../agent-runtime/localLoop";
import { readCommandActionGatePayload } from "../../agent-runtime/actionGate";
import type { PermissionRequest } from "../../agent-runtime/actionGate";
import type { AgentRuntimeToolResult } from "../agentRuntimeLocal";
import { compactDialog, type CompactDialogResult } from "../client/compactDialog";
import { formatAssistantDisplay } from "../client/assistantOutput";
import { isQuotaExhaustedError } from "../agentRunCommand";
import { saveProfileAgentSelection } from "../client/profileConfig";
import { runSelfUpdate } from "../updateCommands";
import { readPipeText, spawnProcess } from "../processSpawn";
import { runConfirmDialog } from "./confirmDialog";
import { createDialogHost } from "./dialogHost";
import { formatAgentSwitchMessage, runAgentPicker } from "./agentPicker";
import { prefetchAgentCatalog } from "./agentCatalog";
import { loadDialogHistory, runDialogPicker } from "./dialogPicker";
import { mergeAttachedImages, readImagePaths, resolveImageSource, summarizeAttachment } from "./pasteImage";
import { getProcessRegistry } from "../../agent-runtime/processRegistry";
import {
  applyTuiInputKey,
  completeSlashCommand,
  createInitialTuiState,
  handleTuiInput,
  formatElapsedSeconds,
  renderPrompt,
  renderStatusLine,
  renderWelcome,
  DEFAULT_TUI_AGENT_KEY,
  PASTE_TOKEN_PREFIX,
  type TuiState,
} from "./session";
import { dimCliText, resolveCliColorEnabled } from "../client/terminalStyles";
import {
  themeColorSequence,
  themeText,
  highlightMarkdown,
  getActiveDensity,
  setActiveBrightness,
} from "./theme";
import { detectTerminalBrightness } from "./detectBackground";
import { toErrorMessage } from "../../core/errorMessage";
import { getCliLocale, initCliLocale, t } from "./i18n";
import { saveProfileLocale } from "../client/profileConfig";
import { createChatQueueTuiBinding, type ChatQueueTuiBinding } from "./chatQueueTuiBinding";

// ANSI / 显示宽度 / 换行纯函数已抽到 ./tuiAnsi。
// Turn 历史 / 滚动渲染已抽到 ./tuiHistory（依赖 ./tuiScrollbar）。
// 此处 re-export 保持对外 API 兼容（sessionRender.ts 及若干测试仍从本文件
// import 这些符号），同时 import 供本文件内部使用。
export {
  ANSI_ESCAPE_REGEX,
  stripAnsi,
  applyTerminalOutputToText,
  displayWidth,
  visibleWidth,
  truncateAnsi,
  fitAnsiLine,
  countPhysicalLines,
  takeDisplayWidth,
  padOrTruncateToWidth,
  wrapTranscriptLine,
  wrapTextToLines,
} from "./tuiAnsi";
export {
  type Turn,
  type TurnHistory,
  createTurnHistory,
  startTurn,
  appendToCurrentTurn,
  finalizeCurrentTurn,
  applyOutputChunkToCurrentTurn,
  renderHistory,
  createHistoryOutputStream,
  applyScrollAction,
} from "./tuiHistory";
export { type ScrollAction, parseScrollAction } from "./tuiScrollbar";
import {
  applyTerminalOutputToText,
  displayWidth,
  fitAnsiLine,
  padOrTruncateToWidth,
  stripAnsi,
  truncateAnsi,
  visibleWidth,
  wrapTextToLines,
  wrapTranscriptLine,
} from "./tuiAnsi";
import {
  applyOutputChunkToCurrentTurn,
  applyScrollAction,
  appendToCurrentTurn,
  createHistoryOutputStream,
  createTurnHistory,
  finalizeCurrentTurn,
  renderHistory,
  startTurn,
  type TurnHistory,
  MAX_TUI_HISTORY_TURNS,
} from "./tuiHistory";
import { parseScrollAction, type ScrollAction } from "./tuiScrollbar";
export {
  type FixedInputController,
  createNoopFixedInput,
  createFixedInput,
  splitRawInput,
  createRawInputDecoder,
} from "./tuiRawInput";
import {
  createFixedInput,
  createNoopFixedInput,
  createRawInputDecoder,
  splitRawInput,
  type FixedInputController,
} from "./tuiRawInput";

/** Max bytes of AGENTS.md/CLAUDE.md to inject — prevents context window overflow. */
const AGENTS_MD_MAX_BYTES = 8192;

/**
 * Read AGENTS.md (or CLAUDE.md fallback) from the workspace root.
 * Returns a formatted context block string, or null when absent.
 * Session-scope: stable across turns in the same workspace.
 */
function readAgentsMdBlock(cwd: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = join(cwd, name);
    if (existsSync(filePath)) {
      try {
        let content = readFileSync(filePath, "utf8").trim();
        if (!content) continue;
        if (Buffer.byteLength(content, "utf8") > AGENTS_MD_MAX_BYTES) {
          content = Buffer.from(content, "utf8").subarray(0, AGENTS_MD_MAX_BYTES).toString("utf8") + "\n\n<!-- AGENTS.md truncated -->";
        }
        return `--- 项目指令（${name}）---\n${content}`;
      } catch { /* skip unreadable */ }
    }
  }
  return null;
}

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
  dialogPickerRunner?: typeof runDialogPicker;
  dialogHistoryLoader?: typeof loadDialogHistory;
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
  setRawMode: (mode: boolean) => unknown;
};



// 对话 → 首轮自动路由结果。镜像 web quick-chat 语义：分类只发生在
// 新对话的第一轮（建对话前），同一段对话的后续轮复用首轮选定的
// agent 与 model 层覆盖，不再重复调用分类器（省钱也省延迟）。
const autoRouteByDialog = new Map<
  string,
  { agentKey: string; agentName: string; modelOverride: ModelLayerOverride | null }
>();

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
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
    abortSignal?: AbortSignal;
    /** True when the user just explicitly switched agent (via /agent or /switch).
     *  Suppresses the cached auto-route so the chosen agent actually runs. */
    explicitAgentSwitch?: boolean;
    activityReporter?: (label: string | null) => void;
  } = {}
) {
  let effectiveAgentKey = state.agentKey;
  let effectiveAgentName = state.agentName;
  let modelOverride: ModelLayerOverride | null = null;
  const continueId = state.dialogId;
  const cachedRoute = continueId ? autoRouteByDialog.get(continueId) : undefined;

  if (cachedRoute && !options.explicitAgentSwitch) {
    // 同一段对话的后续轮：复用首轮路由结果，不再分类。
    // 但若用户刚刚显式 /agent 切换了 agent（例如原 agent 429 了），
    // 必须尊重用户选择，否则缓存会把用户「切走」的 429 agent 又切回来。
    effectiveAgentKey = cachedRoute.agentKey;
    effectiveAgentName = cachedRoute.agentName;
    modelOverride = cachedRoute.modelOverride;
  } else if (!continueId && env.NOLO_AUTO_ROUTE !== "0") {
    // 新对话第一轮（web 的「建对话前」）：LLM 分类器在内置档间选档。
    // 未显式选择 agent（仍是默认平台 agent）→ 直接跑分类出的档位；
    // 显式选择了 agent（/agent 或 NOLO_AGENT）→ 镜像 web 语义：分类照跑，
    // 仅用所选 agent 的 model 层替换档位 agent 的 model 层。
    const authToken =
      env.AUTH_TOKEN ?? env.AUTH ?? env.BENCHMARK_AUTH_TOKEN ?? "";
    const route = await classifyCliAutoRoute(message, {
      serverUrl: state.serverUrl,
      authToken,
    });
    effectiveAgentKey = route.agentKey;
    effectiveAgentName = `auto→${route.tier}`;
    if (state.agentKey !== DEFAULT_TUI_AGENT_KEY) {
      const record = await readDbRecord({
        dbKey: state.agentKey,
        authToken,
        serverUrl: state.serverUrl,
        fetchImpl: fetch,
      }).catch(() => null);
      const override = buildModelLayerOverride(
        record as Record<string, unknown> | null,
      );
      if (override) {
        modelOverride = override;
        effectiveAgentName = `auto→${route.tier}·${state.agentName}`;
      } else {
        // 覆盖源 record 读不到（离线/无权限）→ 保持现状直跑所选 agent。
        effectiveAgentKey = state.agentKey;
        effectiveAgentName = state.agentName;
      }
    }
    if (effectiveAgentKey !== state.agentKey || modelOverride) {
      output.write(
        `\n[nolo] auto → ${route.tier}${modelOverride ? ` (model: ${state.agentName})` : ""}\n`,
      );
    }
  }
  // 图片输入：检测当前 agent 是否支持 vision，不支持则自动切换到 Kimi K2.6。
  // 判定基准是「用户显式选择的 agent」(state.agentKey)，而不是缓存里被首轮分类
  // 覆盖的 effectiveAgentKey——否则显式选了 vision agent（如 agy-flash）的用户，
  // 在同一段对话后续发图时，effectiveAgentKey 仍是首轮的 flash tier key（无 vision），
  // 会被误切到 Kimi。只有用户未显式选 agent（默认平台 agent）时，才用 tier 缓存判。
  const hasImages = options.imageUrls && options.imageUrls.length > 0;
  const userSelectedAgent = state.agentKey !== DEFAULT_TUI_AGENT_KEY;
  const visionProbeKey = hasImages && userSelectedAgent
    ? state.agentKey
    : effectiveAgentKey;
  if (hasImages && effectiveAgentKey !== CLI_IMAGE_AGENT_KEY) {
    let needsVisionSwitch = false;
    if (CLI_AUTO_TIER_AGENT_KEY_TABLE[visionProbeKey]) {
      // 三个 tier agent（flash/balanced/quality）均无 vision 能力。
      needsVisionSwitch = true;
    } else {
      // 用户选择的 agent：读 record 检查 vision 能力。
      const authToken =
        env.AUTH_TOKEN ?? env.AUTH ?? env.BENCHMARK_AUTH_TOKEN ?? "";
      const record = await readDbRecord({
        dbKey: visionProbeKey,
        authToken,
        serverUrl: state.serverUrl,
        fetchImpl: fetch,
      }).catch(() => null);
      if (record && !resolveAgentImageInputSupport(record as AgentCapabilityConfig)) {
        needsVisionSwitch = true;
      }
    }
    if (needsVisionSwitch) {
      output.write(
        `\n[nolo] 当前 agent 不支持图片输入，已自动切换到 Kimi K2.6\n`,
      );
      effectiveAgentKey = CLI_IMAGE_AGENT_KEY;
      effectiveAgentName = "Kimi K2.6";
      modelOverride = null;
    }
  }
  // Resolve attached skill references (dbKey, .agents/skills/<name>/SKILL.md,
  // or docs/skills/<name>.md) and inject as system context blocks — same
  // mechanism as `nolo agent run --skill <ref>`.
  let effectiveMessage = message;
  let skillAllowedTools: string[] | undefined;
  let skillContextBlocks: string[] | undefined;
  if (state.attachedSkills.length > 0) {
    const authToken =
      env.AUTH_TOKEN ?? env.AUTH ?? env.BENCHMARK_AUTH_TOKEN ?? "";
    const resolvedSkills = [];
    for (const ref of state.attachedSkills) {
      try {
        const resolved = await resolveSkillReference(ref, {
          cwd: state.cwd,
          readDbRecord: async (dbKey: string) => {
            return readDbRecord({
              dbKey,
              authToken,
              serverUrl: state.serverUrl,
              fetchImpl: fetch,
            });
          },
        });
        resolvedSkills.push(resolved);
      } catch (error) {
        output.write(`[nolo] skill "${ref}" skipped: ${toErrorMessage(error)}\n`);
      }
    }
    if (resolvedSkills.length > 0) {
      // Build skill content as context blocks (system prompt) instead of
      // prepending to user message — preserves LLM prefix-cache on the
      // system+history prefix across turns.
      skillContextBlocks = buildSkillContextBlocks(resolvedSkills);
      // P3: collect allowed-tools from all skills and intersect
      const toolLists = resolvedSkills
        .map((s) => s.allowedTools)
        .filter((t): t is string[] => !!t && t.length > 0);
      if (toolLists.length > 0) {
        skillAllowedTools = toolLists.reduce((acc, tools) =>
          acc.filter((t) => tools.includes(t))
        );
        if (skillAllowedTools.length === 0) {
          output.write(`[nolo] warning: attached skills declare incompatible allowed-tools; no tool restriction enforced\n`);
        }
      }
    }
  }
  // Read AGENTS.md from cwd (project-level instructions, session-scope)
  const agentsMdBlock = readAgentsMdBlock(state.cwd);
  const extraContextBlocks = [
    ...(agentsMdBlock ? [agentsMdBlock] : []),
    ...(skillContextBlocks ?? []),
  ];
  const result: RunAgentTurnResult = await agentRunner({
    agentName: effectiveAgentName,
    agentKey: effectiveAgentKey,
    serverUrl: state.serverUrl,
    message: effectiveMessage,
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
    ...(options.confirmDestructiveAction
      ? { confirmDestructiveAction: options.confirmDestructiveAction }
      : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.activityReporter ? { activityReporter: options.activityReporter } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(skillAllowedTools !== undefined
      ? { allowedToolNames: skillAllowedTools }
      : {}),
    ...(extraContextBlocks.length > 0
      ? { extraContextBlocks }
      : {}),
  });
  // 首轮分类完成后按对话缓存，同一段对话的后续轮直接复用、不再分类。
  if (
    !continueId &&
    result.dialogId &&
    (effectiveAgentKey !== state.agentKey || modelOverride)
  ) {
    autoRouteByDialog.set(result.dialogId, {
      agentKey: effectiveAgentKey,
      agentName: effectiveAgentName,
      modelOverride,
    });
  }
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
        errorMessage = toErrorMessage(error);
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

function isInteractiveInput(input: NodeJS.ReadableStream): input is RawModeInput & { isTTY: true } {
  const candidate = input as RawModeInput & { isTTY?: boolean };
  return Boolean(candidate.isTTY) && typeof candidate.setRawMode === "function";
}

function waitForRawActionGate(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  gate: LocalAgentActionGate,
  spawnRunner: typeof spawnProcess,
  hooks?: { beforeSubprocess?: () => void; afterSubprocess?: () => void },
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
    const rawInput = input as RawModeInput;
    const finish = (result: AgentRuntimeToolResult) => {
      input.off("data", onData);
      resolve(result);
    };
    const cancel = (reason: string) =>
      finish({
        content: `action gate cancelled: ${gate.title}`,
        metadata: {
          exitCode: 130,
          actionGateResult: { gateId: gate.id, status: "cancelled", output: reason },
        },
      });
    const fail = (message: string) =>
      finish({
        content: `action gate failed: ${gate.title}`,
        metadata: {
          exitCode: 1,
          actionGateResult: { gateId: gate.id, status: "failed", output: message },
        },
      });
    const onData = async (chunk: Buffer | string) => {
      const text = String(chunk);
      if (text.includes("\u0003")) {
        cancel("interrupted");
        return;
      }
      if (!text.includes("\r") && !text.includes("\n")) return;
      if (!commandPayload) {
        fail("unsupported gate payload");
        return;
      }
      const wasRaw = Boolean(rawInput.isRaw);
      rawInput.setRawMode?.(false);
      hooks?.beforeSubprocess?.();
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
        errorMessage = toErrorMessage(error);
      } finally {
        hooks?.afterSubprocess?.();
        if (wasRaw) rawInput.setRawMode?.(true);
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
    };
    input.on("data", onData);
  });
}

export async function startTuiWorkspace(options: WorkspaceOptions) {
  // Locale detection at module load only sees process.env; the workspace env
  // merges the profile config (NOLO_LANG from /lang) on top.
  initCliLocale(options.env ?? process.env);
  let state = createInitialTuiState(options.env ?? process.env);
  // 启动预热 agent 目录缓存：/agent 打开即命中（SWR，后台失败静默）。
  prefetchAgentCatalog({ env: options.env ?? process.env });
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const cliEntrypointPath =
    options.cliEntrypointPath ?? resolveDefaultCliEntrypoint(options.scriptDir);
  const cliCommandRunner = options.cliCommandRunner ?? runCliCommandInChildProcess;
  const spawnRunner = options.spawnRunner ?? spawnProcess;
  const selfUpdater: SelfUpdater =
    options.selfUpdater ?? ((target) => runSelfUpdate({ output: target }));

  if ((output as { isTTY?: boolean }).isTTY) {
    // Clear screen + scrollback so the TUI opens on a clean canvas instead of
    // stacking below whatever the shell printed before launch.
    output.write("\x1b[2J\x1b[3J\x1b[H");
  }

  // Ask the terminal for its background before the first frame is painted, so
  // the welcome banner and status line already use the right palette. Silent
  // terminals resolve null within the timeout and keep the existing default.
  const detected = await detectTerminalBrightness({
    stdin: input as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void },
    stdout: output as NodeJS.WritableStream & { isTTY?: boolean },
  });
  if (detected) setActiveBrightness(detected);

  output.write(renderWelcome(state));

  let fixedInput: FixedInputController = createNoopFixedInput();
  // Composer draft buffer. Hoisted to this scope (rather than the
  // isInteractiveInput block) so that runSubmittedLine's streaming callback
  // can repaint the user's in-progress draft while an agent turn is running.
  let buffer = "";
  // Cooperative stop for the in-flight agent turn (Esc while busy).
  let activeTurnAbort: AbortController | null = null;
  let activityLabel: string | null = null;
  let activityStartedAt = 0;
  let activityFrameIndex = 0;
  let activityTimer: ReturnType<typeof setInterval> | null = null;

  const stopActivity = () => {
    if (activityTimer !== null) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    activityLabel = null;
    activityStartedAt = 0;
  };

  const activityReporter = (label: string | null) => {
    if (label !== null) {
      activityLabel = label;
      if (activityStartedAt === 0) {
        activityStartedAt = Date.now();
      }
      if (activityTimer === null) {
        activityTimer = setInterval(() => {
          activityFrameIndex += 1;
          if (fixedInput.active && !fixedInput.isPaused()) {
            fixedInput.repaint(buffer);
          }
        }, 150);
      }
    } else {
      stopActivity();
      if (fixedInput.active && !fixedInput.isPaused()) {
        fixedInput.repaint(buffer);
      }
    }
  };
  // True after the user explicitly switches agent via /agent or /switch.
  // autoRouteByDialog caches the first-turn router decision per dialog and
  // would otherwise keep replaying the (possibly 429'd) original agent on
  // every follow-up turn, silently overriding the user's manual switch.
  // This flag makes the next runAgentChat honor state.agentKey and drops the
  // cached route, so "switch agent after a 429" actually takes effect.
  let explicitAgentSwitch = false;
  let copyViewExitResolver: (() => void) | null = null;
  const history = createTurnHistory();
  // `fixedInput` is reassigned once the interactive composer is installed, so
  // the host delegates through the binding rather than capturing the noop.
  const dialogHost = createDialogHost({
    composer: {
      pause: () => fixedInput.pause(),
      resumeFromDialog: () => {
        fixedInput.resumeFromDialog();
        // If the terminal was resized while the dialog owned the screen, the
        // composer is still parked at the pre-resize rows (onResize skips
        // repainting while paused). Repaint so it re-docks at the new bottom.
        renderHistoryToOutput();
        fixedInput.repaint(buffer);
      },
      getInputLines: () => fixedInput.getInputLines(),
      isPaused: () => fixedInput.isPaused(),
    },
    output: output as NodeJS.WritableStream,
  });
  const renderHistoryToOutput = () => {
    // A dialog (picker / confirm) owns the screen while paused. Repainting the
    // transcript underneath it erases the frame — mid-turn confirms streamed
    // tokens over the prompt, so it flashed and vanished while still holding
    // the keyboard, and the turn looked hung.
    if (fixedInput.isPaused()) return;
    renderHistory(output, history, fixedInput.getInputLines());
  };
  const readLatestAssistantReply = () => {
    const lastReply = [...history.turns]
      .reverse()
      .find((turn) => turn.role === "assistant")?.content;
    const text = lastReply ? stripAnsi(lastReply).trim() : "";
    return text || null;
  };
  const openCopyView = async () => {
    const text = readLatestAssistantReply();
    if (!text) return false;
    if (!isInteractiveInput(input)) {
      output.write(`${text}\n`);
      return true;
    }

    fixedInput.pause();
    try {
      output.write("\x1b[2J\x1b[H");
      output.write(`${t("copyViewTitle")}\n\n${text}\n\n${t("copyViewHint")}\n`);
      await new Promise<void>((resolve) => {
        copyViewExitResolver = resolve;
      });
    } finally {
      copyViewExitResolver = null;
      output.write("\x1b[2J\x1b[H");
      fixedInput.resumeFromDialog();
      renderHistoryToOutput();
      fixedInput.repaint(buffer);
    }
    return true;
  };

  // --- Chat queue (TUI binding, no Redux) ---
  //
  // runOneAgentTurn executes a single agent turn end-to-end: records the user
  // message into the transcript, runs runAgentChat, finalizes the assistant
  // turn, and folds dialog/token state back. Extracted from runSubmittedLine's
  // chat branch so the queue drain path can reuse the exact same rendering +
  // execution + state-update logic as a direct send.
  const runOneAgentTurn = async (
    message: string,
    imageUrls: string[],
    actionGateHandler: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>,
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>,
  ): Promise<{ ok: boolean; aborted: boolean }> => {
    history.followBottom = true;
    startTurn(history, "user");
    appendToCurrentTurn(history, message);
    finalizeCurrentTurn(history);
    renderHistoryToOutput();
    if (fixedInput.active) fixedInput.repaint(buffer);

    startTurn(history, "assistant");
    const agentOutput = isInteractiveInput(input)
      ? createHistoryOutputStream(history, () => {
          renderHistoryToOutput();
          if (fixedInput.active && !fixedInput.isPaused()) {
            fixedInput.repaint(buffer);
          }
        })
      : output;
    try {
      activeTurnAbort = new AbortController();
      const runResult = await runAgentChat(
        options.scriptDir,
        state,
        message,
        options.env ?? process.env,
        agentOutput,
        options.agentRunner,
        {
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
          actionGateHandler,
          ...(confirmDestructiveAction ? { confirmDestructiveAction } : {}),
          abortSignal: activeTurnAbort.signal,
          explicitAgentSwitch,
          activityReporter,
        }
      );
      const wasAborted = activeTurnAbort.signal.aborted;
      activeTurnAbort = null;
      // An explicit switch only needs to suppress the cached route for the
      // turn it was issued on; once run, normal per-dialog caching resumes.
      explicitAgentSwitch = false;
      if (isInteractiveInput(input)) {
        finalizeCurrentTurn(history);
        renderHistoryToOutput();
        if (fixedInput.active) fixedInput.repaint(buffer);
      }
      if (wasAborted) {
        emitCommandOutput(t("turnStopped"));
      }
      if (runResult.dialogId || runResult.turnTokens) {
        const nextDialogKey = runResult.dialogId
          ? runResult.dialogId === state.dialogId && state.dialogKey
            ? state.dialogKey
            : state.dialogOwnerId
              ? `dialog-${state.dialogOwnerId}-${runResult.dialogId}`
              : undefined
          : state.dialogKey;
        state = {
          ...state,
          ...(runResult.dialogId
            ? {
                dialogId: runResult.dialogId,
                dialogKey: nextDialogKey,
                dialogLabel: runResult.dialogId,
              }
            : {}),
          ...(runResult.turnTokens ? { turnTokens: runResult.turnTokens } : {}),
        };
      }
      // 把 429/额度耗尽这类错误单独识别出来，给一句人话提示 + 可操作的下一步，
      // 而不是把原始报错留在 transcript 里让用户自己去猜「现在该怎么办」。
      // localError 来自本地 runtime（exitCode 1 + localError）；server runtime 的
      // 429 文本已被 agentRun 直接写进 agentOutput，这里只在 localError 可用时复检。
      if (
        !wasAborted &&
        runResult.exitCode !== 0 &&
        isQuotaExhaustedError(runResult.localError)
      ) {
        emitCommandOutput(t("quotaExhaustedHint"));
      }
      return { ok: !wasAborted, aborted: wasAborted };
    } finally {
      stopActivity();
      activeTurnAbort = null;
      explicitAgentSwitch = false;
    }
  };

  // The TUI chat queue binding drives drain via runOneAgentTurn. It is created
  // here (inside the workspace closure) so the drain callback can capture
  // history/state/fixedInput/runAgentChat just like a direct send does.
  let chatQueueBinding: ChatQueueTuiBinding | null = null;
  const ensureChatQueueBinding = (
    actionGateHandler: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>,
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>
  ): ChatQueueTuiBinding => {
    if (chatQueueBinding) return chatQueueBinding;
    chatQueueBinding = createChatQueueTuiBinding(async (text) => {
      return runOneAgentTurn(text, [], actionGateHandler, confirmDestructiveAction);
    });
    return chatQueueBinding;
  };

  const emitCommandOutput = (text: string) => {
    if (!text) return;
    if (!isInteractiveInput(input)) {
      output.write(`${text}\n`);
      return;
    }
    history.followBottom = true;
    startTurn(history, "assistant");
    appendToCurrentTurn(history, text);
    finalizeCurrentTurn(history);
    renderHistoryToOutput();
    if (fixedInput.active) fixedInput.repaint(buffer);
  };

  const runSubmittedLine = async (
    line: string,
    actionGateHandler: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>,
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>,
  ) => {
    if (!line.trim()) return false;
    const result = handleTuiInput(line, state);
    const previousAgentKey = state.agentKey;
    state = result.nextState;

    // In interactive mode the transcript pane is owned by renderHistory; a raw
    // output.write lands inside the scroll region and is wiped by the next
    // composer repaint (\x1b[J), which made /context et al invisible. Route
    // command echo + output through history instead.
    const interactive = isInteractiveInput(input);

    if (interactive && result.action?.type !== "chat") {
      history.followBottom = true;
      startTurn(history, "user");
      appendToCurrentTurn(history, line.trim());
      finalizeCurrentTurn(history);
      renderHistoryToOutput();
      if (fixedInput.active) fixedInput.repaint(buffer);
    }

    if (result.output) {
      emitCommandOutput(result.output);
    }

    if (state.agentKey !== previousAgentKey) {
      // 用户显式切换 agent（/agent <name>、/switch <name> 或 picker）：
      // 清掉这条对话首轮 auto-route 的缓存，否则下一轮会被缓存切回原
      // agent（典型场景：原 agent 429 后想换一个）。判定只看 agentKey 是否
      // 变化，不耦合 "Switched to " 这类输出文案——文案一旦 i18n 化或调整，
      // 字符串前缀判定就会漏掉切换、导致缓存不清、切换「不生效」回归。
      if (state.dialogId) autoRouteByDialog.delete(state.dialogId);
      explicitAgentSwitch = true;
      persistAgentSelection(state, options.env ?? process.env);
    }

    if (result.action?.type === "exit") return true;

    if (result.action?.type === "clear") {
      history.turns.length = 0;
      history.currentRole = null;
      history.currentContent = "";
      history.scrollTop = 0;
      history.followBottom = true;
      renderHistoryToOutput();
      // Re-emit after the wipe: the pre-clear echo of /new was just discarded
      // along with the rest of the transcript.
      const sparkle = [
        "",
        `     🏔  ${t("startedFreshDialog")}`,
        "     ────────────────────────────",
        "",
      ].join("\n");
      emitCommandOutput(themeText(sparkle, "chrome", resolveCliColorEnabled()));
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
          dialogKey: compactResult.dialogKey,
          dialogLabel: compactResult.dialogId,
        };
      } catch (error: any) {
        output.write(
          `[nolo] Compact failed: ${toErrorMessage(error)}\n`
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
        output.write(`${toErrorMessage(error)}\n`);
        output.write("Update failed. Check the error above, then run /update again or use nolo update.\n");
      }
    }

    if (result.action?.type === "pick-agent") {
      try {
        const pickResult = await dialogHost.run((anchor) =>
          runAgentPicker({
            currentKey: state.agentKey,
            env: options.env ?? process.env,
            input: input as NodeJS.ReadStream,
            output: output as NodeJS.WritableStream,
            ...anchor,
          }),
        );
        if (pickResult.kind === "list") {
          output.write(`${pickResult.output}\n`);
        } else if (pickResult.kind === "selected") {
          state = {
            ...state,
            agentName: pickResult.name,
            agentKey: pickResult.key,
          };
          // 用户显式切换 agent：清掉这条对话首轮 auto-route 的缓存，否则
          // 下一轮会被缓存切回原 agent（典型场景：原 agent 429 后想换一个）。
          if (state.dialogId) autoRouteByDialog.delete(state.dialogId);
          explicitAgentSwitch = true;
          persistAgentSelection(state, options.env ?? process.env);
          output.write(
            `${formatAgentSwitchMessage({
              name: pickResult.name,
              dialogId: state.dialogId,
            })}\n`
          );
        } else {
          output.write(`${t("agentSwitchCancelled")}\n`);
        }
      } catch (error) {
        output.write(
          `[nolo] Agent picker failed: ${toErrorMessage(error)}\n`
        );
      }
    }

    if (result.action?.type === "set-locale") {
      try {
        saveProfileLocale(result.action.locale);
      } catch {
        // Locale still applies for this session; persistence is best-effort.
      }
    }

    if (result.action?.type === "set-mouse") {
      fixedInput.setMouseEnabled(result.action.enabled);
    }

    if (result.action?.type === "copy-view") {
      const opened = await openCopyView();
      if (!opened) emitCommandOutput(t("copyNothing"));
    }

    if (result.action?.type === "copy-last") {
      const text = readLatestAssistantReply() ?? "";
      if (!text) {
        emitCommandOutput(t("copyNothing"));
      } else {
        try {
          const { default: clipboard } = await import("clipboardy");
          await clipboard.write(text);
          emitCommandOutput(t("copiedLastReply"));
        } catch (error) {
          // Headless / container shells often lack xclip/pbcopy; surface the
          // reply text so the user can still copy it manually instead of only
          // seeing a raw "spawn xclip ENOENT".
          const message = toErrorMessage(error);
          const missingClipboard =
            /ENOENT|not found|no such file|clipboard|spawn|EPIPE|EACCES/i.test(message) ||
            /clipboard/i.test(String(error?.constructor?.name ?? ""));
          if (missingClipboard) {
            emitCommandOutput(t("copyUnavailable"));
            emitCommandOutput(text);
          } else {
            emitCommandOutput(`[nolo] ${t("copyFailed")}: ${message}`);
          }
        }
      }
    }

    if (result.action?.type === "pick-dialog") {
      const interactivePicker = isInteractiveInput(input);
      try {
        const pickResult = await dialogHost.run((anchor) =>
          (options.dialogPickerRunner ?? runDialogPicker)({
            env: options.env ?? process.env,
            input: input as NodeJS.ReadStream,
            output: output as NodeJS.WritableStream,
            interactive: interactivePicker,
            ...anchor,
            bottomAnchored: interactivePicker,
          }),
        );
        if (pickResult.kind === "selected") {
          const loadedTurns = await (
            options.dialogHistoryLoader ?? loadDialogHistory
          )({
            dialog: pickResult.dialog,
            env: options.env ?? process.env,
          });
          // /resume 恢复的是数据库里的原始 markdown，必须经过和新回复（流式）
          // 同一套完整渲染器，否则表格/列表/链接会降级成 highlightMarkdown 处理
          // 不了的原始语法。只渲染 assistant turn：user turn 靠 ❯ 标记区分，
          // buildHistoryLines 里 user 分支不走 markdown 渲染。mode 取
          // state.renderDisplay 以尊重 /render plain；整段消息用默认 trimEdges。
          const restored = loadedTurns
            .slice(-MAX_TUI_HISTORY_TURNS)
            .map((turn) =>
              turn.role === "assistant"
                ? {
                    ...turn,
                    content: formatAssistantDisplay(
                      turn.content,
                      state.renderDisplay,
                    ),
                  }
                : turn,
            );
          history.turns.length = 0;
          history.turns.push(...restored);
          history.currentRole = null;
          history.currentContent = "";
          history.scrollTop = 0;
          history.followBottom = true;
          state = {
            ...state,
            dialogId: pickResult.dialog.id,
            dialogKey: pickResult.dialog.dbKey,
            dialogLabel: pickResult.dialog.id,
            turnTokens: undefined,
          };
          emitCommandOutput(
            `${t("resumedDialogPrefix")}: ${pickResult.dialog.title} (${pickResult.dialog.id})`,
          );
        } else if (pickResult.kind === "list") {
          emitCommandOutput(pickResult.output);
        } else if (pickResult.kind === "error") {
          emitCommandOutput(`[nolo] ${pickResult.message}`);
        } else {
          emitCommandOutput(t("dialogResumeCancelled"));
        }
      } catch (error) {
        emitCommandOutput(
          `[nolo] History failed: ${toErrorMessage(error)}`,
        );
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
          `[nolo] Agent list failed: ${toErrorMessage(error)}\n`
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
          `[nolo] CLI command failed: ${toErrorMessage(error)}\n`
        );
      }
    }

    if (result.action?.type === "shell-command") {
      const shellCmd = result.action.command;
      if (!shellCmd) {
        emitCommandOutput("[nolo] Error: No command specified after !");
      } else {
        emitCommandOutput(`Executing: ${shellCmd}`);
        try {
          const proc = spawnRunner({
            cmd: ["/bin/sh", "-c", shellCmd],
            cwd: state.cwd,
            env: options.env ?? process.env,
            stdout: "pipe",
            stderr: "pipe",
          });

          const [stdoutText, stderrText] = await Promise.all([
            readPipeText(proc.stdout),
            readPipeText(proc.stderr),
          ]);

          const exitCode = await proc.exited;

          if (stdoutText) {
            emitCommandOutput(`\`\`\`\n${stdoutText.trim()}\n\`\`\``);
          }
          if (stderrText) {
            emitCommandOutput(themeText(`\`\`\`\nError:\n${stderrText.trim()}\n\`\`\``, "danger", resolveCliColorEnabled()));
          }
          if (exitCode !== 0) {
            emitCommandOutput(themeText(`[nolo] Command exited with code ${exitCode}.`, "warning", resolveCliColorEnabled()));
          }
        } catch (error) {
          emitCommandOutput(
            themeText(`[nolo] Command execution failed: ${toErrorMessage(error)}`, "danger", resolveCliColorEnabled())
          );
        }
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

      history.followBottom = true;
      // Notify the queue core that a direct (non-drained) turn is starting,
      // then execute it via the shared runOneAgentTurn helper. After it ends,
      // notifyTurnEnd drives the drain cascade for any messages the user
      // queued while this turn was running.
      const binding = ensureChatQueueBinding(actionGateHandler, confirmDestructiveAction);
      binding.notifyTurnStart();
      try {
        const outcome = await runOneAgentTurn(
          result.action.message,
          imageUrls,
          actionGateHandler,
          confirmDestructiveAction,
        );
        await binding.notifyTurnEnd(outcome);
      } catch (err) {
        // A throw here (e.g. a post-stream persistence / server-replication
        // failure inside the agent runner) must NOT leave the queue machine
        // stuck in `running`. That was the root cause of "the reply finished
        // but every later message silently goes to the queue and never
        // drains": notifyTurnEnd was never reached, so `running` stayed true
        // and no future turn-end drove a drain. Report a failed (non-aborted)
        // turn-end — chatQueueMachine keeps the queue on failure — and surface
        // the error instead of swallowing it.
        await binding.notifyTurnEnd({ ok: false, aborted: false });
        emitCommandOutput(
          `${t("turnFailed")}${err instanceof Error && err.message ? `\n${err.message}` : ""}`,
        );
      }
      if (fixedInput.active) fixedInput.repaint(buffer);
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

    return false;
  };

  if (isInteractiveInput(input)) {
    input.setRawMode(true);
    output.write("\x1b[?2004h");
    let busy = false;
    let done = false;
    // True while a raw action gate is waiting for the user to press Enter.
    // The gate owns the keyboard during this modal phase (its own `data`
    // listener handles Enter/Ctrl+C), so the main loop must not let stray
    // keys leak into the composer draft buffer — otherwise a key typed while
    // the gate is open gets prepended to the next submitted line (e.g. `x`
    // before `/exit` yields `x/exit`, which is not recognized as /exit and
    // the process never exits). Mirrors how the non-raw gate path uses
    // rl.pause() to give the gate exclusive keyboard access.
    let actionGateWaiting = false;
    fixedInput = createFixedInput(output, {
      getStatusLine: () => {
        let base = renderStatusLine(state);
        // Show the queued-input count while a turn is running so the user can
        // see their follow-ups are staged, not lost. Mirrors the Web/RN
        // queue badge via the shared projectChatQueueStatus contract.
        if (chatQueueBinding && chatQueueBinding.queueLength() > 0) {
          base += dimCliText(
            ` · ${chatQueueBinding.queueLength()} ${t("queuedHint")}`,
            resolveCliColorEnabled(),
          );
        }
        if (history.hasMoreAbove || history.hasMoreBelow) {
          const scrollHints: string[] = [];
          if (history.hasMoreAbove) scrollHints.push("▲ PgUp");
          if (history.hasMoreBelow) scrollHints.push("▼ PgDn");
          base += dimCliText(` · ↕ ${scrollHints.join("/")}`, resolveCliColorEnabled());
        }
        return base;
      },
      getActivityLine: () => {
        if (activityLabel === null) return null;
        const colorEnabled = resolveCliColorEnabled();
        const FRAMES = ["·", "~", "≈", "∿", "≈", "~"];
        const frame = FRAMES[activityFrameIndex % FRAMES.length];
        const elapsedSec =
          activityStartedAt > 0
            ? Math.max(0, Math.floor((Date.now() - activityStartedAt) / 1000))
            : 0;
        const elapsed = formatElapsedSeconds(elapsedSec);
        const stopHint = t("stopHint");
        if (!colorEnabled) {
          return `${frame} ${activityLabel} (${elapsed}) · ${stopHint}`;
        }
        return (
          themeText(frame, "accent") +
          " " +
          themeText(activityLabel, "muted") +
          themeText(` (${elapsed})`, "chrome") +
          themeText(` · ${stopHint}`, "chrome")
        );
      },
      getQueueLines: () => {
        if (!chatQueueBinding || chatQueueBinding.queueLength() === 0) return [];
        const colorEnabled = resolveCliColorEnabled();
        // queuePreview is the shared projection: up to 3 entries, each already
        // truncated to 40 chars. Render each as a dim "⤷ <text>" line so the
        // staged follow-ups are visible above the composer. Newlines in a
        // queued paste must be collapsed to a single-line marker: each entry is
        // one `sections` row, and an embedded "\n" would emit extra physical
        // lines that headerRows doesn't count, drifting the input cursor.
        return chatQueueBinding
          .getStatus()
          .queuePreview.map((text, i) => {
            const oneLine = text.replace(/\r?\n/g, " ⏎ ");
            return dimCliText(`  ⤷ ${i + 1}. ${oneLine}`, colorEnabled);
          });
      },
    });
    fixedInput.init();
    const paintFrame = (draft: string) => {
      renderHistoryToOutput();
      fixedInput.repaint(draft);
    };
    const onResize = () => {
      if (done || copyViewExitResolver) return;
      // Re-measure rows/cols, rebuild scroll region + full-width rules, repaint.
      // Keep the user's current draft visible even during an agent turn so
      // typing is not lost on terminal resize.
      if (fixedInput.isPaused()) {
        // A dialog (picker / confirm) owns the rows above the composer.
        // Repaint the transcript + composer underneath anyway: terminal
        // reflow on resize garbles absolute-row frames (stale fragments,
        // vanished composer), and the dialog's own resize listener —
        // registered after this one — repaints its frame on top.
        renderHistory(output, history, fixedInput.getInputLines());
        fixedInput.repaint(buffer);
        return;
      }
      paintFrame(buffer);
    };
    const resizeTarget = output as NodeJS.WritableStream & {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    resizeTarget.on?.("resize", onResize);
    const finish = () => {
      if (done) return;
      done = true;
      resizeTarget.off?.("resize", onResize);
      input.off("data", onData);
      output.write("\x1b[?2004l");
      input.setRawMode?.(false);
    };
    const handleInputToken = async (sequence: string) => {
      if (done) return;
      if (copyViewExitResolver) {
        if (
          sequence === "\x1b" ||
          sequence === "\r" ||
          sequence === "\n" ||
          sequence === "\u0003"
        ) {
          const exitCopyView = copyViewExitResolver;
          copyViewExitResolver = null;
          exitCopyView();
        }
        return;
      }
      // While a raw action gate is waiting for Enter, the gate's own `data`
      // listener owns the keyboard. Drop everything else so random keys do
      // not accumulate in the composer draft buffer and corrupt the next
      // submitted line once the gate resolves.
      if (actionGateWaiting) return;
      // While an agent turn is running we let the user keep typing into the
      // docked composer (draft buffer) but ignore submit so a second turn
      // cannot race the in-flight one. The draft is preserved and shown
      // once the turn finishes via fixedInput.exitOutputMode(buffer).
      const busyLock = busy;
      const scrollAction = parseScrollAction(sequence);
      if (scrollAction) {
        // Scrolling only reads history state, so it stays available during an
        // agent turn; block it only while a picker/confirm dialog or
        // subprocess owns the screen (repainting would corrupt their UI).
        if (fixedInput.isPaused()) return;
        applyScrollAction(history, scrollAction, output, fixedInput.getInputLines());
        paintFrame(buffer);
        return;
      }
      // Esc while a turn is running = cooperative stop. A lone \x1b token is
      // only produced for a real Esc press (arrow keys arrive as full CSI
      // sequences), so this cannot swallow other keys.
      if (busyLock && sequence === "\x1b" && activeTurnAbort) {
        activeTurnAbort.abort();
        return;
      }
      const result = applyTuiInputKey(buffer, sequence);
      if (result.copyView) {
        if (busyLock) return;
        busy = true;
        const opened = await openCopyView();
        busy = false;
        if (!opened) {
          history.followBottom = true;
          startTurn(history, "assistant");
          appendToCurrentTurn(history, t("copyNothing"));
          finalizeCurrentTurn(history);
          paintFrame(buffer);
        }
        return;
      }
      if (result.abort) {
        fixedInput.disable();
        finish();
        return;
      }
      if (result.submit !== undefined) {
        if (busyLock) {
          // While an agent turn is running, Enter does not start a new turn.
          // Instead, route the draft through the shared queue resolver: pure
          // text is enqueued for auto-send after the turn; slash commands and
          // attachments are surfaced as a brief notice (the user can retry
          // once the turn ends). The draft is cleared only on a successful
          // enqueue.
          const submittedText = result.submit;
          const trimmedText = submittedText.trim();
          if (trimmedText === "/context" || trimmedText === "/ctx") {
            // Busy /context is a read-only probe, executed locally right now.
            // It MUST NOT touch the shared history state machine: while a
            // turn runs the assistant stream owns currentRole/currentContent,
            // and calling startTurn("user") here would prematurely finalize
            // the half-streamed reply; the tail chunks would then land under
            // currentRole===null and be silently dropped by
            // finalizeCurrentTurn, losing the end of the answer from the
            // transcript permanently. It also shouldn't persist into history
            // as a conversation turn (it's not one).
            // Route through a transient render channel: write straight to the
            // output stream. The next streaming repaint will overwrite it,
            // which is the desired behavior for an ephemeral query.
            const res = handleTuiInput(submittedText, state);
            state = res.nextState;
            if (res.output) {
              output.write(`${res.output}\n`);
            }
            buffer = "";
            if (fixedInput.active) fixedInput.repaint(buffer);
            return;
          }
          const binding = ensureChatQueueBinding(
            async (gate) => {
              actionGateWaiting = true;
              try {
                return await waitForRawActionGate(input, output, gate, spawnRunner, {
                  beforeSubprocess: () => fixedInput.pause(),
                  afterSubprocess: () => fixedInput.resumeFromSubprocess(),
                });
              } finally {
                actionGateWaiting = false;
              }
            },
            async (request) =>
              dialogHost.run((anchor) =>
                runConfirmDialog({
                  request,
                  input: input as any,
                  output: output as any,
                  ...anchor,
                }),
              ),
          );
          const decision = binding.resolveSubmit({
            text: submittedText,
            isRunning: true,
          });
          if (decision.kind === "queue-text") {
            binding.enqueue(decision.text);
            buffer = "";
            fixedInput.repaint(buffer);
          } else if (decision.kind === "queue-blocked") {
            // Attachments / mentions can't be queued yet; keep the draft so
            // the user can resend after the turn. No destructive action.
          }
          // arm-fresh-dialog / compact-blocked / noop / multi-image-blocked
          // are all intentionally no-ops while busy: the draft is preserved
          // and the user can act on it once the turn completes.
          return;
        }
        busy = true;
        const submittedText = result.submit;
        buffer = "";
        // Note: we intentionally keep the `data` listener attached. During the
        // agent turn the user can still type into the composer; submit is
        // gated by `busy` above. This avoids tearing the input chrome down
        // and lets the draft persist across the turn.
        fixedInput.enterOutputMode(submittedText);
        // `busy` gates whether Enter starts a turn or queues. It MUST be
        // released no matter how runSubmittedLine settles; leaving it stuck
        // (an unhandled throw used to do exactly that) silently routes every
        // later Enter into the queue with no way to drain. The finally is the
        // last-resort guard; runSubmittedLine also handles turn errors itself.
        let shouldExit = false;
        try {
          shouldExit = await runSubmittedLine(
            submittedText,
            async (gate) => {
              actionGateWaiting = true;
              try {
                return await waitForRawActionGate(input, output, gate, spawnRunner, {
                  beforeSubprocess: () => fixedInput.pause(),
                  afterSubprocess: () => fixedInput.resumeFromSubprocess(),
                });
              } finally {
                actionGateWaiting = false;
              }
            },
            async (request) =>
              dialogHost.run((anchor) =>
                runConfirmDialog({
                  request,
                  input: input as any,
                  output: output as any,
                  ...anchor,
                }),
              ),
          );
        } finally {
          busy = false;
        }
        if (shouldExit) {
          fixedInput.disable();
          finish();
          return;
        }
        // Status may have picked up token usage during the turn — repaint chips.
        // Restore the user's draft (which may have been edited while busy).
        fixedInput.exitOutputMode(buffer);
        return;
      }
      buffer = result.buffer;
      fixedInput.repaint(buffer);
    };
    const onData = createRawInputDecoder((token) => {
      void handleInputToken(token);
    });
    try {
      input.on("data", onData);
      fixedInput.repaint(buffer);
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (done) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
    } finally {
      finish();
    }
    return;
  }

  const rl = createInterface({ input, output });
  rl.setPrompt(renderPrompt(state));
  rl.prompt();

  try {
    for await (const line of rl) {
      const shouldExit = await runSubmittedLine(
        line,
        (gate) => waitForActionGate(rl, input, output, gate, spawnRunner),
        async (request) => {
          rl.pause();
          try {
            return await dialogHost.run((anchor) =>
              runConfirmDialog({
                request,
                input: input as any,
                output: output as any,
                ...anchor,
              }),
            );
          } finally {
            rl.resume();
          }
        },
      );
      if (shouldExit) break;
      output.write(`\n${renderStatusLine(state)}\n`);
      rl.setPrompt(renderPrompt(state));
      rl.prompt();
    }
  } finally {
    getProcessRegistry().stopAll();
    rl.close();
  }
}
