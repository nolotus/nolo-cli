import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runAgentTurn, type RunAgentTurnResult } from "../client/agentRun";
import {
  createCliLocalRuntimeAdapter,
  type UserChoiceRequest,
  type UserChoiceResult,
} from "../client/localRuntimeAdapter";
import { resolveSkillReference, buildSkillContextBlocks } from "../agentRunPrompts";
import { buildSkillDiscoveryContextLayer } from "../../agent-runtime/skillDiscovery";
import {
  buildAgentsMdLayer,
  buildMemoryOverlayLayer,
  buildMemoryUseGuidanceLayer,
  partitionScopedBlocks,
  renderTurnContextBlocksWithScope,
  type TurnContextLayer,
} from "../../agent-runtime/turnContext";
import { resolvePlatformAuthToken } from "../../agent-runtime/providerResolution";
import { resolveCliMemory } from "../memoryRecall";
import { deleteDbRecord, readDbRecord } from "../agentRecordHelpers";
import {
  resolveAgentContextWindow,
  resolveAgentModelIdentity,
} from "../client/tokenUsage";
import { estimateDefaultCliContextTokens } from "../client/estimateCliContext";
import type { LocalAgentActionGate } from "../../agent-runtime/localLoop";
import type { ContextBlockScope } from "../../agent-runtime/contextBlockScope";
import { readCommandActionGatePayload } from "../../agent-runtime/actionGate";
import type { PermissionRequest } from "../../agent-runtime/actionGate";
import type { AgentRuntimeToolResult } from "../agentRuntimeLocal";
import { compactDialog, type CompactDialogResult } from "../client/compactDialog";
import { isBalanceExhaustedError, isQuotaExhaustedError } from "../agentRunCommand";
import {
  getAgentSelectionAuditPath,
  getDefaultProfileConfigPath,
  readLastAgentSelectionAudit,
  saveProfileAgentSelection,
} from "../client/profileConfig";
import { checkForCliUpdate, runSelfUpdate } from "../updateCommands";
import { readPipeText, spawnProcess } from "../processSpawn";
import { runConfirmDialog } from "./confirmDialog";
import { runSelectDialog, type SelectDialogItem } from "./selectDialog";
import { runAskChoiceDialog } from "./askChoiceDialog";
import { createDialogHost } from "./dialogHost";
import { createActivityIndicator, type AgentRunStatusSnapshot } from "./activityIndicator";
import { createRunRegistryPoller } from "./runRegistryPoller";
import { createRunCompletionWatcher } from "./runCompletionWatcher";
import { createTurnRequest, type InternalTurnEvent, type TurnRequest } from "../../core/chat/internalTurnEvent";
import { checkStaleRun, readRunRecord } from "../agentRunControl";
import { formatAgentSwitchMessage, runAgentPicker } from "./agentPicker";
import { prefetchAgentCatalog } from "./agentCatalog";
import { loadDialogHistoryForDisplay, runDialogPicker } from "./dialogPicker";
import { mergeAttachedImages, readImagePaths, resolveImageSource, summarizeAttachment } from "./pasteImage";
import { detectGitStatusAsync } from "./gitStatus";
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
  getActiveDensity,
  getActiveBrightness,
  setActiveBrightness,
  setActiveTerminalBaseHex,
  applyDetectedBackground,
} from "./theme";
import { detectTerminalBackground } from "./detectBackground";
import {
  clearCollapsedPasteStore,
  createCollapsedPasteStore,
  releaseCollapsedPasteReferences,
  replaceCollapsedPastesWithReferences,
  type CollapsedPasteStore,
} from "../../core/collapsedPaste";
import { toErrorMessage } from "../../core/errorMessage";
import { getCliLocale, initCliLocale, t } from "./i18n";
import { saveProfileLocale } from "../client/profileConfig";
import { createChatQueueTuiBinding, type ChatQueueTuiBinding } from "./chatQueueTuiBinding";
import { emitTerminalBell, shouldEmitTerminalBell } from "./terminalNotification";

// Ctrl+S (0x13): flush all queued follow-ups as one merged message. Named so
// the raw byte is greppable by intent ("Ctrl+S" / "flush") rather than only by
// hex. Node's setRawMode(true) disables IXON flow control, so this byte
// reaches the `data` listener on all supported platforms.
const CTRL_S = "\x13";

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
  buildWindowTitle,
} from "./tuiAnsi";
export {
  type Turn,
  type TurnHistory,
  createTurnHistory,
  startTurn,
  appendToCurrentTurn,
  finalizeCurrentTurn,
  appendLocalTurn,
  applyOutputChunkToCurrentTurn,
  renderHistory,
  resetHistoryFrameDiffCache,
  createHistoryOutputStream,
  applyScrollAction,
} from "./tuiHistory";
export { type ScrollAction, parseScrollAction } from "./tuiScrollbar";
import {
  applyTerminalOutputToText,
  buildWindowTitle,
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
  appendLocalTurn,
  commitTurnToTerminal,
  createHistoryOutputStream,
  createTurnHistory,
  finalizeCurrentTurn,
  formatTurnLines,
  renderHistory,
  resetHistoryFrameDiffCache,
  startTurn,
  type TurnHistory,
  MAX_TUI_HISTORY_TURNS,
} from "./tuiHistory";
import {
  parseScrollAction,
  type ScrollAction,
} from "./tuiScrollbar";
export {
  type FixedInputController,
  createNoopFixedInput,
  createFixedInput,
  splitRawInput,
  createRawInputDecoder,
  enterAltScreen,
  leaveAltScreen,
  isAltScreenOn,
} from "./tuiRawInput";
import {
  createFixedInput,
  createNoopFixedInput,
  createRawInputDecoder,
  splitRawInput,
  enterAltScreen,
  leaveAltScreen,
  type FixedInputController,
} from "./tuiRawInput";

/** Max bytes of AGENTS.md/CLAUDE.md to inject — prevents context window overflow. */
const AGENTS_MD_MAX_BYTES = 8192;

/**
 * Alternate-screen restore for non-normal exit paths.
 *
 * `disable()` (the normal exit) restores the terminal itself; but SIGINT /
 * SIGTERM / SIGHUP, an uncaught exception, an unhandled rejection, or a raw
 * `process.exit` can bypass it. Without a restore on those paths the user's
 * terminal stays on the alternate screen and the shell prompt is invisible
 * — they can only recover with a manual `reset`. So every abnormal path
 * leaves the alternate screen *before* the error is surfaced / the process
 * dies, so the message prints on the main screen where the user can see it.
 *
 * Single registration guard: `startTuiWorkspace` may be called more than
 * once (tests, re-entry), and stacking process listeners trips Node's
 * MaxListenersExceededWarning. `altScreenHandlersInstalled` makes the
 * install block idempotent. The handlers themselves are safe to fire
 * repeatedly: `leaveAltScreen` is idempotent, and the signal handler is
 * prepended once (the pre-existing listeners are re-attached after it so
 * each runs exactly once per signal).
 */
let altScreenRestoreOutput: NodeJS.WritableStream | null = null;
let altScreenHandlersInstalled = false;

/**
 * Snapshot of pre-existing signal listeners captured at install time, for
 * which we guarantee exactly-once delivery after our own restore runs. They
 * are detached from the emitter (so Node does not dispatch them itself) and
 * re-attached *after* our restore handler — Node then walks the listener
 * array in order on the signal: restore (once) → each original (once).
 */
const preExistingSignalListeners: Partial<
  Record<NodeJS.Signals, NodeJS.SignalsListener[]>
> = {};

/**
 * Signal → conventional shell exit code (128 + signum). SIGINT=2 → 130,
 * SIGTERM=15 → 143, SIGHUP=1 → 129. Used only when there are no pre-existing
 * listeners for that signal: registering *any* listener suppresses Node's
 * default "terminate on signal", so we must terminate explicitly to avoid a
 * zombie process that `kill` cannot reach.
 */
const SIGNAL_EXIT_CODE: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/**
 * Restore the terminal and alternate screen to the main screen. Never throws:
 * the output stream may already be destroyed (e.g. after a crash), in which
 * case the write silently fails — the terminal is gone, nothing more to do.
 */
const restoreAltScreen = () => {
  try {
    if (altScreenRestoreOutput) {
      leaveAltScreen(altScreenRestoreOutput);
      if ((altScreenRestoreOutput as { isTTY?: boolean }).isTTY) {
        altScreenRestoreOutput.write("\x1b[r\x1b[?2004l\x1b[?25h");
      }
    }
  } catch {
    // Stream destroyed / write failed: the terminal is already gone.
  }
};

export function installAltScreenRestoreHandlers(
  output: NodeJS.WritableStream,
): void {
  altScreenRestoreOutput = output;
  if (altScreenHandlersInstalled) return;
  altScreenHandlersInstalled = true;

  process.on("exit", restoreAltScreen);

  // For signals: restore the terminal FIRST (so the shell prompt is visible
  // / the error prints on the main screen), then let any pre-existing
  // listeners run. We do not swallow the signal, we only prepend the restore.
  //
  // Design (exactly-once for originals): we PREPEND our handler and leave the
  // pre-existing listeners attached. On the signal Node walks the listener
  // array in order — our restore handler first, then each pre-existing
  // listener exactly once (Node invokes them itself; we never call them
  // manually, so there is no double-fire, which the prior cache-and-replay
  // design suffered: Node fired the original AND our handler fired it again).
  // If there are no pre-existing listeners we must terminate explicitly,
  // because registering *any* listener suppresses Node's default
  // "terminate on signal" behavior — otherwise the process hangs on the main
  // screen and `kill` cannot reach it.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const existing = process.listeners(sig) as NodeJS.SignalsListener[];
    preExistingSignalListeners[sig] = [...existing];

    const handler: NodeJS.SignalsListener = () => {
      restoreAltScreen();
      // Query live listenerCount or snapshot: if only this handler is registered,
      // re-terminate explicitly with the conventional 128+signum code.
      const count = process.listenerCount(sig);
      const hasOtherListeners =
        (preExistingSignalListeners[sig]?.length ?? 0) > 0 || count > 1;
      if (!hasOtherListeners) {
        process.exit(SIGNAL_EXIT_CODE[sig] ?? 128 + 1);
        return;
      }
      // Pre-existing listeners present: they remain attached to the emitter
      // and will be invoked by Node itself (once each, after us).
    };
    // Prepend so restore runs before the pre-existing (and any later-attached)
    // listeners.
    process.prependListener(sig, handler);
  }

  // Restore first, then surface the error on the MAIN screen (the alternate
  // screen is about to vanish, so anything printed there is invisible).
  // We do NOT swallow the error: print the original error to stderr so the
  // owner can see the crash reason, then exit non-zero. Registering this
  // listener cancels Node's default "print stack + exit(1)" — so we must
  // re-create it explicitly, otherwise the process hangs on the main screen
  // while the 150ms render timer keeps overwriting it.
  process.on("uncaughtException", (err) => {
    restoreAltScreen();
    try {
      process.stderr.write(
        `uncaughtException: ${err?.stack ?? String(err)}\n`,
      );
    } catch {
      // stderr write failing must not mask the restore.
    }
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    restoreAltScreen();
    try {
      const text = reason instanceof Error
        ? reason.stack ?? String(reason)
        : String(reason);
      process.stderr.write(`unhandledRejection: ${text}\n`);
    } catch {
      // ignore stderr write failures
    }
    process.exit(1);
  });
}

/**
 * Read AGENTS.md (or CLAUDE.md fallback) from the workspace root.
 * Returns the runtime's canonical agents-md layer, or null when absent.
 *
 * The block text and its cacheScope both come from `buildAgentsMdLayer` — this
 * host must not format the marker itself, or downstream consumers are forced
 * to string-match it back to recover the scope.
 */
function readAgentsMdLayer(cwd: string): TurnContextLayer | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = join(cwd, name);
    if (existsSync(filePath)) {
      try {
        let content = readFileSync(filePath, "utf8").trim();
        if (!content) continue;
        if (Buffer.byteLength(content, "utf8") > AGENTS_MD_MAX_BYTES) {
          content = Buffer.from(content, "utf8").subarray(0, AGENTS_MD_MAX_BYTES).toString("utf8") + "\n\n<!-- AGENTS.md truncated -->";
        }
        return buildAgentsMdLayer(content, name);
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
  agentRunner?: typeof runAgentTurn;
  compactRunner?: (options: {
    serverUrl: string;
    authToken: string;
    dialogId: string;
    summaryLlmCaller?: (content: string) => Promise<string | null>;
  }) => Promise<CompactDialogResult>;
  dialogPickerRunner?: typeof runDialogPicker;
  dialogHistoryLoader?: typeof loadDialogHistoryForDisplay;
  selfUpdater?: SelfUpdater;
  spawnRunner?: typeof spawnProcess;
  /** Injected summary LLM caller for /compact compression. Wired by localRuntimeAdapter. */
  summaryLlmCaller?: (content: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  saveAgentSelection?: typeof saveProfileAgentSelection;
};


type RawModeInput = NodeJS.ReadableStream & {
  isRaw?: boolean;
  setRawMode: (mode: boolean) => unknown;
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
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
    requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
    abortSignal?: AbortSignal;
    pastedTextStore?: CollapsedPasteStore;
    activityReporter?: (label: string | null) => void;
    /**
     * 后台 run 状态快照的接收者（dock 面板）。曾经在本签名里声明缺失、调用
     * 处传了却被静默丢弃，导致模型轮询那条面板上料链路整根断掉；补上声明
     * 后会在下面转发给 agentRunner。
     */
    onAgentRunStatus?: (snapshot: AgentRunStatusSnapshot | null) => void;
  } = {}
) {
  // 用户选中的 agent 就是要跑的 agent —— 不再做首轮自动改写，也不再按对话
  // 缓存路由结果。旧实现只在「新对话第一轮」把默认 agent 拨到 flash 档，续聊
  // （-c / 重启 TUI）时缓存已失效、分支也不进，于是原样落回默认 agent；默认
  // agent 的模型一旦变贵，用户在毫无提示的情况下按新价计费。
  const effectiveAgentKey = state.agentKey;
  const effectiveAgentName = state.agentName;
  const continueId = state.dialogId;
  // 图片输入：图片档已移除，不再自动切换到 Kimi K2.6。
  // 纯文本模型收到图片时，会剥离 image_url part 为占位文本（见
  // imagePreprocessing.ts），避免上游 400。用户如需完整视觉可手动 /switch 到支持视觉的模型。
  // Resolve attached skill references (dbKey, .agents/skills/<name>/SKILL.md)
  // and inject as system context blocks — same
  // mechanism as `nolo agent run --skill <ref>`.
  let effectiveMessage = message;
  let skillAllowedTools: string[] | undefined;
  let skillContextBlocks: string[] | undefined;
  if (state.attachedSkills.length > 0) {
    const authToken = resolvePlatformAuthToken(env);
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
  // Assemble the turn's context layers. Each builder stamps its own cacheScope
  // (session = stable prefix, cached; turn = dynamic suffix, recomputed), so
  // this host never has to infer scope by string-matching block markers.
  const layers: Array<TurnContextLayer | null> = [
    readAgentsMdLayer(state.cwd),
    // Skill discovery: scan conventional skill dirs for SKILL.md and inject an
    // index layer so the model knows what skills exist and can readFile them
    // on-demand. Mirrors agentRunCommand.ts and desktopAgentRuntimeTurnService.
    buildSkillDiscoveryContextLayer(state.cwd),
  ];

  // Memory overlay: session-scoped — load once per dialog, reuse across turns.
  // New memories written via rememberMemory tool are for FUTURE dialogs, not
  // the current one (the model already has the context from the conversation).
  // /new or dialog switch clears cachedMemoryOverlay so the next dialog reloads.
  let memoryPromptBlock = state.cachedMemoryOverlay;
  if (memoryPromptBlock === undefined) {
    memoryPromptBlock = await resolveCliMemory({
      serverUrl: state.serverUrl,
      authToken: resolvePlatformAuthToken(env),
      agentKey: effectiveAgentKey,
      userInput: effectiveMessage,
      env,
    }).catch(() => null);
    // Cache will be propagated to TUI state by the caller via runResult.cachedMemoryOverlay.
  }
  const memoryOverlayLayer = buildMemoryOverlayLayer({ promptBlock: memoryPromptBlock });
  const memoryUseGuidanceLayer = buildMemoryUseGuidanceLayer({ promptBlock: memoryPromptBlock });

  const contextBlockScopes: ContextBlockScope[] = partitionScopedBlocks([
    ...renderTurnContextBlocksWithScope(layers),
    ...renderTurnContextBlocksWithScope([memoryUseGuidanceLayer]),
    // Attached skill bodies are already self-contained sections built by
    // buildSkillContextBlocks; they stay turn-scope because the user can
    // attach/detach skills between turns.
    ...(skillContextBlocks ?? [])
      .map((content) => content.trim())
      .filter((content) => content.length > 0)
      .map((content) => ({ content, cacheScope: "turn" as const })),
    ...renderTurnContextBlocksWithScope([memoryOverlayLayer]),
  ]);
  const result: RunAgentTurnResult = await agentRunner({
    agentName: effectiveAgentName,
    agentKey: effectiveAgentKey,
    serverUrl: state.serverUrl,
    message: effectiveMessage,
    continueDialogId: state.dialogId,
    ...(state.agentKey === DEFAULT_TUI_AGENT_KEY && env.NOLO_AUTO_ROUTE !== "0"
      ? { dialogAgentMode: "auto" as const }
      : { dialogAgentMode: "fixed" as const }),
    runtimeMode: state.runtimeMode,
    // `/lang` updates the in-memory TUI state immediately. Pass that state
    // explicitly so the next real turn cannot keep using the workspace's
    // launch-time NOLO_LANG value while the estimator already uses the new one.
    userLanguage: state.userLanguage,
    localRuntimeCwd: process.cwd(),
    scriptDir,
    env: {
      ...env,
      NOLO_LANG: state.userLanguage,
      NOLO_CLI_TOOLS: state.toolDisplay,
    },
    output,
    ...(options.imageUrls && options.imageUrls.length > 0
      ? { imageUrls: options.imageUrls }
      : {}),
    ...(options.actionGateHandler ? { actionGateHandler: options.actionGateHandler } : {}),
    ...(options.confirmDestructiveAction
      ? { confirmDestructiveAction: options.confirmDestructiveAction }
      : {}),
    ...(options.requestUserChoice
      ? { requestUserChoice: options.requestUserChoice }
      : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    // Always inject a local adapter factory so background run delegations from
    // inside a TUI turn are stamped with the current conversation. Previously
    // this factory only existed when pasted text was present, which meant a
    // plain (no-paste) turn had no injection point for parentDialogId and the
    // run-completion watcher could never attribute runs spawned this turn.
    ...(options.pastedTextStore?.items.size
      ? { pastedTextStore: options.pastedTextStore }
      : {}),
    localRuntimeAdapterFactory: (
      factoryEnv: Record<string, string | undefined>,
      factoryOptions?: { cwd?: string },
    ) =>
      createCliLocalRuntimeAdapter({
        env: factoryEnv,
        cwd: factoryOptions?.cwd ?? state.cwd,
        output,
        ...(options.confirmDestructiveAction
          ? { confirmDestructiveAction: options.confirmDestructiveAction }
          : {}),
        ...(options.requestUserChoice
          ? { requestUserChoice: options.requestUserChoice }
          : {}),
        ...(options.pastedTextStore
          ? { pastedTextStore: options.pastedTextStore }
          : {}),
        // Stamp spawned background runs with the current TUI dialog so the
        // run-completion watcher can attribute terminal-state wakes to this
        // conversation.
        ...(state.dialogId ? { parentDialogId: state.dialogId } : {}),
        ...(options.activityReporter
          ? { activityReporter: options.activityReporter }
          : {}),
      }),
    ...(options.activityReporter ? { activityReporter: options.activityReporter } : {}),
    // 转发 dock 订阅：runAgentTurn 的输出层靠它判断「有面板」从而抑制
    // transcript 的进展卡片；dock 本身也靠它接收模型轮询带回来的快照。
    ...(options.onAgentRunStatus ? { onAgentRunStatus: options.onAgentRunStatus } : {}),
    ...(skillAllowedTools !== undefined
      ? { allowedToolNames: skillAllowedTools }
      : {}),
    ...(contextBlockScopes.length > 0
      ? { contextBlockScopes }
      : {}),
  });
  return {
    ...result,
    contextWindow: resolveAgentContextWindow({
      agentKey: effectiveAgentKey,
      agentName: effectiveAgentName,
    }),
    cachedMemoryOverlay: memoryPromptBlock,
  };
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
  const isInteractiveHandoff =
    gate.kind === "handoff" &&
    gate.title === "This command requires an interactive terminal.";
  const title = isInteractiveHandoff
    ? t("actionGateInteractiveTitle")
    : gate.title;
  const body = isInteractiveHandoff
    ? t("actionGateInteractiveBody")
    : gate.body;
  output.write(`\n[nolo] ${t("actionGateNeeded")}\n`);
  output.write(`[nolo] ${title}\n`);
  if (body) output.write(`[nolo] ${body}\n`);
  output.write(`  ${displayCommand}\n`);
  output.write(`[nolo] ${t("actionGateEnterHint")}\n`);
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

/**
 * One dim line naming the origin of a non-default startup agent, or "" when
 * the session starts on the default (nothing to explain) or the agent came
 * from an explicit `NOLO_AGENT` in the shell (the user just typed it).
 */
export function renderPinnedAgentNotice(
  state: TuiState,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  auditPath = getAgentSelectionAuditPath(),
): string {
  if (state.agentKey === DEFAULT_TUI_AGENT_KEY) return "";
  if (env.NOLO_AGENT_SOURCE !== "profile") return "";
  const base = t(
    "agentPinnedFromProfile",
    state.agentName,
    getDefaultProfileConfigPath(),
  );
  // Attribution is the whole point of this line, so keep the two "no record"
  // cases apart: no log at all means a build without the audit trail wrote it,
  // while a log with no matching entry only means the entry aged out.
  const { logExists, last } = readLastAgentSelectionAudit(auditPath);
  const suffix = !logExists
    ? ` ${t("agentPinnedUnaudited")}`
    : last?.agentKey !== state.agentKey
      ? ` ${t("agentPinnedAuditRotated")}`
      : "";
  return `${dimCliText(`${base}${suffix}`, resolveCliColorEnabled())}\n`;
}

function persistAgentSelection(
  state: TuiState,
  env: NodeJS.ProcessEnv | undefined,
  saveSelection: typeof saveProfileAgentSelection = saveProfileAgentSelection,
) {
  // 默认档（nolo）不落盘：profile 里存的是「用户显式选择了哪个 agent」，
  // 存了默认档下次启动就分不清「没选过」和「选了 nolo」，而 NOLO_AGENT 一旦
  // 有值，createInitialTuiState 就再也走不到 DEFAULT_TUI_AGENT_KEY 兜底。
  //
  // 只比对 key。这里曾经附带 `agentName === "auto"` 的条件，但自动路由收敛成
  // 单档后状态行改为始终显示 agent 名（默认 "nolo"），该条件恒为 false，
  // 默认档因此被当成显式选择写进了 profile。
  // 空 key/name = 清除选择；profile 与 env 是同一份意图的两个落点。
  const selection = state.agentKey === DEFAULT_TUI_AGENT_KEY
    ? { agentKey: "", agentName: "" }
    : { agentKey: state.agentKey, agentName: state.agentName };

  try {
    saveSelection(selection);
  } catch {
    // profile persistence is best-effort in the workspace loop
  }

  if (!env) return;
  if (selection.agentKey) {
    env.NOLO_AGENT = selection.agentKey;
    env.NOLO_AGENT_NAME = selection.agentName;
  } else {
    delete env.NOLO_AGENT;
    delete env.NOLO_AGENT_NAME;
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
  hooks?: {
    beforeSubprocess?: () => void;
    afterSubprocess?: () => void;
    /** Route decoded TTY tokens through the workspace decoder. */
    registerToken?: (handler: ((token: string) => void) | null) => void;
  },
): Promise<AgentRuntimeToolResult> {
  const commandPayload = gate.kind === "handoff"
    ? readCommandActionGatePayload(gate.payload)
    : null;
  const displayCommand = commandPayload?.displayCommand ?? commandPayload?.command.join(" ") ?? gate.title;
  const isInteractiveHandoff =
    gate.kind === "handoff" &&
    gate.title === "This command requires an interactive terminal.";
  const title = isInteractiveHandoff
    ? t("actionGateInteractiveTitle")
    : gate.title;
  const body = isInteractiveHandoff
    ? t("actionGateInteractiveBody")
    : gate.body;
  output.write(`\n[nolo] ${t("actionGateNeeded")}\n`);
  output.write(`[nolo] ${title}\n`);
  if (body) output.write(`[nolo] ${body}\n`);
  output.write(`  ${displayCommand}\n`);
  output.write(`[nolo] ${t("actionGateEnterHint")}\n`);

  return new Promise((resolve) => {
    const rawInput = input as RawModeInput;
    let settled = false;
    let commandRunning = false;
    const finish = (result: AgentRuntimeToolResult) => {
      if (settled) return;
      settled = true;
      hooks?.registerToken?.(null);
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
    const runCommand = async () => {
      if (settled || commandRunning) return;
      commandRunning = true;
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
    const handleToken = (text: string) => {
      if (settled || commandRunning) return;
      if (text.includes("\u0003")) {
        cancel("interrupted");
        return;
      }
      if (text.includes("\r") || text.includes("\n")) {
        void runCommand();
      }
    };
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      handleToken(text);
    };
    if (hooks?.registerToken) {
      hooks.registerToken(handleToken);
    } else {
      input.on("data", onData);
    }
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnRunner = options.spawnRunner ?? spawnProcess;
  const selfUpdater: SelfUpdater =
    options.selfUpdater ?? ((target) => runSelfUpdate({ output: target }));

  const env = options.env ?? process.env;
  const startInAltScreen = (env.NOLO_TUI_ALTSCREEN ?? "").trim() === "1";

  if ((output as { isTTY?: boolean }).isTTY) {
    if (startInAltScreen) {
      enterAltScreen(output);
      output.write("\x1b[2J\x1b[H");
    }
    // Register the terminal-restore handlers (exit / signals / exceptions)
    // once per process. Installing here (after we know we're on a TTY) keeps
    // the no-op guarantee for non-TTY runs: pipes/redirects/tests never touch
    // the alternate screen, and the handlers short-circuit via leaveAltScreen.
    installAltScreenRestoreHandlers(output);
  }

  // Ask the terminal for its background before the first frame is painted, so
  // the welcome banner and status line already use the right palette. Silent
  // terminals resolve null within the timeout and keep the existing default.
  const detected = await detectTerminalBackground({
    stdin: input as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void },
    stdout: output as NodeJS.WritableStream & { isTTY?: boolean },
    allowSystemFallback: true,
  });
  if (detected) {
    setActiveBrightness(detected.brightness);
    setActiveTerminalBaseHex(detected.hex);
  }

  // Paint the welcome banner once, statically. The previous 15-frame animation
  // blocked composer setup for ~1.5s (the input box only appeared after the
  // loop finished) and repainted by moving the cursor up a fixed 8 lines. When
  // any banner line wrapped on a narrow terminal the real on-screen line count
  // exceeded 8, so the cursor never reached the top and each frame's sky row
  // (✦ 🌙  ·) was left behind, stacking into the vertical columns seen in the
  // bug report. A single static frame performs no cursor rewind, so wrapping
  // can never corrupt it, and the composer mounts immediately afterwards. The
  // terminal width is passed through so renderWelcome can drop the wide scene
  // art on narrow terminals instead of letting it wrap.
  const bannerColumns = (output as { columns?: number }).columns;
  // 首帧字符串复用两次：写出 + 行数计算。避免把渲染逻辑（含主题/终端状态
  // 读取）执行两遍，导致首帧与行数计算不一致。
  const initialWelcome = renderWelcome(state, 0, 0, bannerColumns);
  output.write(initialWelcome);
  let initialBannerLineCount = initialWelcome.split("\n").length;

  // Starting on a non-default agent is always the result of a *saved* choice,
  // and the file that holds it can be rewritten by any other session. Name the
  // origin on the first frame so a pinned agent is never a silent surprise;
  // the audit trail (~/.nolo/agent-selection.log) says who wrote it.
  const pinnedAgentNotice = renderPinnedAgentNotice(
    state,
    options.env ?? process.env,
  );
  if (pinnedAgentNotice) {
    output.write(pinnedAgentNotice);
    initialBannerLineCount += pinnedAgentNotice.split("\n").length - 1;
  }

  let lastSentTitle: string | null = null;
  const syncWindowTitle = () => {
    if (!(output as { isTTY?: boolean }).isTTY) return;
    const env = options.env ?? process.env;
    const rawSetting = (env.NOLO_TUI_TITLE ?? "").trim().toLowerCase();
    if (rawSetting === "0" || rawSetting === "false") return;

    const currentTitle = state.dialogLabel?.trim() ?? "";
    if (currentTitle === lastSentTitle) return;
    lastSentTitle = currentTitle;
    output.write(buildWindowTitle(currentTitle));
  };

  syncWindowTitle();

  let fixedInput: FixedInputController = createNoopFixedInput();
  // Composer draft buffer. Hoisted to this scope (rather than the
  // isInteractiveInput block) so that runSubmittedLine's streaming callback
  // can repaint the user's in-progress draft while an agent turn is running.
  let buffer = "";
  // Cursor position is hoisted for the same reason as `buffer`: the streaming
  // and activity repaints defined in this scope call
  // fixedInput.repaint(buffer, cursorPos) so a streaming token that repaints
  // mid-edit keeps the caret where the user left it (e.g. mid-draft after an
  // arrow-key move) instead of the `cursorPos ?? buffer.length` fallback in
  // renderInputArea snapping it to the line end.
  let cursorPos = 0;
  // Oversized bracketed pastes collapse to `[paste #N · L lines]` chips in the
  // draft. Submitted turns carry a compact model reference; the full bodies
  // stay for the current dialog so later local turns can page them through
  // readPastedText. /new and process shutdown clear the store.
  const pasteStore = createCollapsedPasteStore();
  // Cooperative stop for the in-flight agent turn (Esc while busy).
  let activeTurnAbort: AbortController | null = null;
  // 本轮已强制收尾标志：第二次 Esc 直接把 UI 交还用户后置 true。
  // runAgentChat 的 await 仍会在稍后返回，此时 activeTurnAbort 已被强制清空、
  // busyLock 已解除；这段迟到返回值必须被丢弃：不重复打印 turnStopped、
  // 不重新置位 busyLock、不触发收尾重绘（用户可能已开始新一轮输入）。
  // 用 epoch 而非单 boolean：强制停止后用户可能立刻发起新 turn，新 turn
  // 会重置 forcedStop；旧 turn 的 await 稍后返回时靠 epoch 比对识别自己被
  // 强制过，不被新 turn 的重置影响。
  let forcedStop = false;
  let forcedStopEpoch = 0;
  let turnEpoch = 0;
  // 当前正在运行的 turn 的 epoch（activeTurnAbort 非空时有效）。
  // Esc 强制停止时据此设置 forcedStopEpoch，让对应的 runOneAgentTurn
  // await 返回后能识别自己被强制过。
  let activeTurnEpoch = 0;
  // 活动行状态机抽到 activityIndicator.ts：explicit 标签（working locally /
  // 工具标签）优先，静默超过阈值时自动补 working fallback，填补「文本流完模型
  // 在憋 tool_call」「tool-result 到下一轮」这些此前全黑的空窗。
  const activityIndicator = createActivityIndicator({
    isTurnActive: () => activeTurnAbort !== null,
    fallbackLabel: () => `${state.agentName} -> working`,
    stoppingLabel: () => t("turnStopping"),
    onRepaint: () => {
      if (fixedInput.active && !fixedInput.isPaused()) {
        output.write("\x1b[?2026h\x1b[?25l");
        try {
          fixedInput.repaint(buffer, cursorPos);
        } finally {
          output.write("\x1b[?25h\x1b[?2026l");
        }
      }
    },
  });
  const activityReporter = (label: string | null) =>
    activityIndicator.report(label);
  // 停靠区的第二条数据来路：直接读 ~/.nolo/runs 的记录。不经过模型，所以
  // 「面板要动」不再需要编排 agent 每隔几十秒调一次 controlAgentRun（那正是
  // transcript 被状态卡片刷屏的根因）。跑在服务端的 run 本地读不到记录，
  // 轮询器对它们视而不见，仍走模型那条路。
  // 终态唤醒：轮询器每 tick 把读到的 run 记录推给观察器，「活跃→终态」的
  // 转变被合并成一条唤醒消息。投递策略（turn 进行中就排队、空闲就直接开
  // 新 turn）由交互层在下方通过 runWakeHandler 注入；非交互模式没有投递
  // 通道，runWakeHandler 保持 null，消息丢弃。
  let runWakeHandler: ((event: InternalTurnEvent | string) => void) | null = null;
  const runCompletionWatcher = createRunCompletionWatcher({
    getCurrentDialogId: () => state.dialogId ?? null,
    onWake: (text) => runWakeHandler?.(text),
  });
  const runRegistryPoller = createRunRegistryPoller({
    getDockedRuns: () => activityIndicator.getAgentRuns(),
    update: (snapshot) => activityIndicator.updateAgentRun(snapshot),
    // 显式传 env：resolveNoloHome 只认传入 env 的 NOLO_HOME，不传则永远读
    // ~/.nolo——设了 NOLO_HOME 的环境（dev、测试）会读错目录。run 记录读取
    // 与 reconcile 的调用点也是同样写法。
    readRecord: (runId) => readRunRecord(runId, { env: process.env }),
    reconcile: (runId) => checkStaleRun(runId, { env: process.env }),
    onRecordsPolled: (records) => runCompletionWatcher.observe(records),
  });
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
        flushPendingRender();
        renderHistoryToOutput();
        fixedInput.repaint(buffer, cursorPos);
      },
      getInputLines: () => fixedInput.getInputLines(),
      isPaused: () => fixedInput.isPaused(),
    },
    output: output as NodeJS.WritableStream,
  });
  // ── Render coalescing + terminal sync ──────────────────────────────────
  // Streaming chunks arrive faster than the terminal can paint without
  // flicker. Coalesce multiple onUpdate calls in the same macrotask into a
  // single render frame, and wrap each frame in BSU/ESU (2026h/l) + cursor
  // hide/show so the terminal never shows a half-painted intermediate state.
  // Coalesce streaming chunks into ~30fps frames; keystroke composer repaints
  // go through fixedInput.repaint directly and are unaffected; flushPendingRender
  // remains immediate for turn boundaries.
  const RENDER_THROTTLE_MS = 33;
  let renderScheduled = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  // Set true by finish() once the interactive session has exited. Lives in the
  // outer scope (alongside refreshGitStatus) so the async git callback can drop
  // a stale repaint that would land after /exit. `done` is block-scoped inside
  // the interactive branch below and is not visible here.
  let sessionEnded = false;

  const flushPendingRender = () => {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (!renderScheduled) return;
    renderScheduled = false;
    paintSyncedFrame();
  };

  const paintSyncedFrame = () => {
    if (fixedInput.isPaused()) return;
    // Begin terminal sync update + hide cursor. Terminals without 2026
    // support silently ignore the sequence; cursor hide is a universal
    // fallback that still reduces visible flicker.
    output.write("\x1b[?2026h\x1b[?25l");
    try {
      renderHistory(output, history, fixedInput.getInputLines());
      if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
    } finally {
      output.write("\x1b[?25h\x1b[?2026l");
    }
  };

  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    renderTimer = setTimeout(() => {
      renderScheduled = false;
      renderTimer = null;
      paintSyncedFrame();
    }, RENDER_THROTTLE_MS);
  };

  const refreshGitStatus = (): void => {
    // Per-key fallback: an explicit options.env that omits the key still
    // inherits the process-level kill switch (workspace tests pass env: {}).
    if ((options.env?.NOLO_CLI_GIT_STATUS ?? process.env.NOLO_CLI_GIT_STATUS) === "0") return;
    void detectGitStatusAsync(state.cwd).then((gitStatus) => {
      if (sessionEnded) return; // session exited while git ran — skip the stale repaint
      state = { ...state, gitStatus };
      scheduleRender();
    });
  };

  // 版本发布快（AI 辅助开发每次合入即发版）：启动时异步查一次 npm registry
  // 当前通道的最新版。检查永远不阻塞启动、失败静默（离线/超时/registry 抖动
  // 都当无更新），NOLO_CLI_NO_UPDATE_CHECK=1 可整体禁用。结果到达时若用户还
  // 停在欢迎页（未开始对话），从顶部重绘 banner 把 /update 提示带出来；已
  // 在对话中则只更新 state，不打断当前画面。
  const repaintBanner = () => {
    if (!(output as { isTTY?: boolean }).isTTY) return;
    // modal / dialog 拥有屏幕（如 /help、confirm）时不重绘，否则会擦掉弹层。
    if (fixedInput.isPaused()) return;
    if (modalOwnsKeyboard) return; // picker / confirm 弹层持有键盘时不重绘
    // 终端可能已 resize：重绘时实时读宽度，让 renderWelcome 重新决定是否
    // 保留 scene，避免旧宽度下画的 banner 在新宽度 wrap 出残留。
    const currentColumns = (output as { columns?: number }).columns ?? 80;
    const welcome = renderWelcome(state, 0, 0, currentColumns);
    const lines = welcome.split("\n");
    // 窄终端下 update hint / welcome hint 这类长行会物理换行，破坏"逻辑行数 =
    // 物理行数"的逐行定位；写入前按列宽截断，保证每行正好占一行。
    const safeWidth = Math.max(1, currentColumns);
    const safeLines = lines.map((line) => padOrTruncateToWidth(line, safeWidth));
    const clearLines = Math.max(initialBannerLineCount, safeLines.length);
    // 与 paintSyncedFrame 一致的 BSU/ESU + 光标隐藏包裹，避免清行与写入
    // 之间的中间帧闪烁；composer 重绘也在同一帧内完成。
    output.write("\x1b[?2026h\x1b[?25l");
    try {
      let frame = "";
      // 先清掉旧 banner 区域（含窄终端无 scene 的短 banner），再逐行定位写入
      // 新 banner。注意不能只 \x1b[H 一次后拼接多行文本：清行循环会把光标停在
      // 最后清的那行，welcome 会从那里开始画（banner 掉到屏幕中部）。
      for (let i = 0; i < clearLines; i++) frame += `\x1b[${i + 1};1H\x1b[2K`;
      safeLines.forEach((line, i) => {
        frame += `\x1b[${i + 1};1H${line}`;
      });
      output.write(frame);
      // 顶部 banner 区域重绘不影响底部 composer，但活动输入行的绘制状态需要
      // 恢复，否则光标/缓冲行与终端实际内容脱节。
      if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
    } finally {
      output.write("\x1b[?25h\x1b[?2026l");
    }
  };
  void checkForCliUpdate(state.cliVersion, state.serverUrl, {
    fetchImpl,
    env: options.env ?? process.env,
  }).then((updateAvailable) => {
    if (sessionEnded || !updateAvailable) return;
    state = { ...state, updateAvailable };
    // 欢迎页仍在屏幕上才重绘 banner：turns 为空且没有正在流式输出的 turn。
    // 第一轮 turn 开始后（currentRole 非空）transcript 已接管顶部，此时只
    // 更新 state，不打断画面。
    if (history.turns.length === 0 && history.currentRole === null) {
      repaintBanner();
    } else {
      scheduleRender();
    }
  });

  // 防重入卫兵：onInputLinesChange → renderHistoryToOutput → 若 composer 重绘
  // 又触发 onInputLinesChange → 无限递归把 CPU 打满。重入时直接 return。
  let syncingLayout = false;

  const renderHistoryToOutput = () => {
    // A dialog (picker / confirm) owns the screen while paused. Repainting the
    // transcript underneath it erases the frame — mid-turn confirms streamed
    // tokens over the prompt, so it flashed and vanished while still holding
    // the keyboard, and the turn looked hung.
    if (fixedInput.isPaused()) return;
    if (syncingLayout) return;
    syncingLayout = true;
    try {
      renderHistory(output, history, fixedInput.getInputLines());
    } finally {
      syncingLayout = false;
    }
  };
  const readLatestAssistantReply = () => {
    const lastReply = [...history.turns]
      .reverse()
      .find((turn) => turn.role === "assistant")?.content;
    const text = lastReply ? stripAnsi(lastReply).trim() : "";
    return text || null;
  };

  // True while a modal (raw action gate OR ask_choice popup) owns the
  // keyboard. The modal's own `data` listener handles its keys (Enter/Esc/
  // Ctrl+C/arrow keys), so the main loop must not let stray keys leak into
  // the composer draft buffer — otherwise a key typed while the modal is
  // open gets prepended to the next submitted line (e.g. `x` before `/exit`
  // yields `x/exit`, which is not recognized as /exit and the process never
  // exits), or — for ask_choice — Esc meant to cancel the popup also aborts
  // the whole turn (activeTurnAbort). Mirrors how the non-raw gate path uses
  // rl.pause() to give the gate exclusive keyboard access.
  // Hoisted above runOneAgentTurn so the requestUserChoice closure (which
  // wraps an ask_choice dialog) can set/clear it without a forward-reference.
  let modalOwnsKeyboard = false;
  let rawActionGateTokenHandler: ((token: string) => void) | null = null;

  // Auto-follow the terminal theme while the session runs: poll the background
  // (OSC 11) every 30s and silently repaint when Ghostty et al. switch
  // light<->dark. Only when the startup probe answered (`detected`), input is a
  // real TTY, and the kill switch is not set. `/theme light|dark` pins
  // brightness (getActiveBrightness() !== null) and pauses the poller;
  // `/theme auto` (null) resumes it. A poll that gets no reply stops the timer.
  // Defined after sessionEnded / renderHistoryToOutput / modalOwnsKeyboard /
  // fixedInput are declared (no TDZ forward references).
  const AUTO_THEME_POLL_MS = 30_000;
  let autoThemeTimer: ReturnType<typeof setInterval> | null = null;
  const maybeAutoRefreshTheme = async () => {
    // Exit, a subprocess owning the TTY, or a modal owning the screen: skip a
    // probe (writing OSC 11 / attaching stdin would pollute them) and skip the
    // silent repaint (it would stomp the modal's frame). React on the next tick.
    if (sessionEnded) return;
    if (fixedInput.isPaused()) return; // git pager / editor / dialog owns the TTY
    if (modalOwnsKeyboard) return; // picker / confirm modal owns the screen
    if (getActiveBrightness() !== null) return; // manual /theme light|dark pinned it
    if (!isInteractiveInput(input)) return;
    const detected = await detectTerminalBackground({
      stdin: input as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void },
      stdout: output as NodeJS.WritableStream & { isTTY?: boolean },
      allowSystemFallback: true,
    });
    if (sessionEnded) return; // exited while awaiting the 100ms probe — don't write to a restored TTY
    if (!detected) {
      if (autoThemeTimer !== null) {
        clearInterval(autoThemeTimer);
        autoThemeTimer = null;
      }
      return;
    }
    if (applyDetectedBackground(detected)) {
      // Terminal switched light<->dark (or exact bg color changed). Silent
      // repaint with the same BSU/ESU + cursor guard the activity indicator uses.
      if (fixedInput.active && !fixedInput.isPaused() && !modalOwnsKeyboard) {
        output.write("\x1b[?2026h\x1b[?25l");
        try {
          renderHistoryToOutput();
          fixedInput.repaint(buffer, cursorPos);
        } finally {
          output.write("\x1b[?25h\x1b[?2026l");
        }
      }
    }
  };
  if (
    detected &&
    isInteractiveInput(input) &&
    (options.env ?? process.env).NOLO_TUI_AUTO_THEME !== "0"
  ) {
    autoThemeTimer = setInterval(() => {
      void maybeAutoRefreshTheme();
    }, AUTO_THEME_POLL_MS);
  }

  // --- Chat queue (TUI binding, no Redux) ---
  //
  // runOneAgentTurn executes a single agent turn end-to-end: records the user
  // message into the transcript, runs runAgentChat, finalizes the assistant
  // turn, and folds dialog/token state back. Extracted from runSubmittedLine's
  // chat branch so the queue drain path can reuse the exact same rendering +
  // execution + state-update logic as a direct send.
  const runOneAgentTurn = async (
    inputMsg: TurnRequest | InternalTurnEvent | string,
    imageUrls: string[],
    actionGateHandler: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>,
    confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>,
  ): Promise<{ ok: boolean; aborted: boolean }> => {
    // LLM 总结标题是 fire-and-forget 后台 patch：saveTurn 返回的 title 是
    // fallback（不阻塞 turn），真正标题 patch 完成后把最终标题同步到
    // dialogLabel + OSC 窗口标题，避免窗口标题停留在 fallback 直到下一轮
    // turn 才刷新（title 节流 30 分钟，可能很久看不到总结标题）。
    // 校验 dialogId 仍是当前 dialog：patch 是异步的，用户可能已 /new 或
    // /pick 切走，不能把旧 dialog 的标题盖到新 dialog 上。
    const scheduleTitlePatchSync = (runResult: RunAgentTurnResult) => {
      if (!runResult.titlePatchPromise || !runResult.dialogId) return;
      const patchDialogId = runResult.dialogId;
      runResult.titlePatchPromise
        .then((patchedTitle) => {
          if (!patchedTitle || sessionEnded) return;
          if (state.dialogId !== patchDialogId) return;
          if (state.dialogLabel === patchedTitle) return;
          state = {
            ...state,
            dialogLabel: patchedTitle,
            dialogTitle: patchedTitle,
          };
          syncWindowTitle();
        })
        .catch(() => {
          // 静默：patch 失败下一轮节流会重试，不值得打扰用户。
        });
    };
    const req = createTurnRequest(inputMsg);
    if (req.event.kind === "child-run-completed") {
      for (const r of req.event.runs) {
        runCompletionWatcher.markAcknowledged(r.runId);
      }
    }
    const message = req.text;
    // 每轮 turn 开始时重置强制收尾标志，确保上一轮的强制停止不会泄漏到本轮。
    forcedStop = false;
    turnEpoch += 1;
    const myEpoch = turnEpoch;
    history.followBottom = true;
    // 屏幕上印什么 ≠ 送进模型的是什么。终态唤醒是系统事件，不是用户发言：
    // 模型仍收完整摘要（message），transcript 只留一行紧凑状态，且不套用户
    // 气泡——否则每条 run 完成都在对话里伪造一条几百字的「用户消息」。
    const isInternalEvent = req.event.kind !== "user";
    const transcriptText =
      req.event.kind === "child-run-completed"
        ? (req.event.displayText ?? req.event.text)
        : message;
    startTurn(history, isInternalEvent ? "assistant" : "user");
    appendToCurrentTurn(
      history,
      isInternalEvent
        ? dimCliText(transcriptText, resolveCliColorEnabled())
        : transcriptText,
    );
    finalizeCurrentTurn(history);
    renderHistoryToOutput();
    if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);

    startTurn(history, "assistant");
    const agentOutput = isInteractiveInput(input)
      ? createHistoryOutputStream(history, () => {
          scheduleRender();
        })
      : output;
    // Interactive ask_user: dock an arrow-key select dialog above the
    // composer (same dialogHost + runSelectDialog as the /agent picker) and
    // resolve the user's pick into the userMessage that continues the turn.
    // Only wired in interactive TUI mode; headless/CI falls back to text menu.
    const requestUserChoice =
      isInteractiveInput(input) && dialogHost
        ? async (req: UserChoiceRequest): Promise<UserChoiceResult> => {
            // The ask_choice popup installs its own raw-key reader on stdin,
            // but dialogHost.run only composer.pause()s and does NOT detach
            // the global `input.on("data", onData)` listener. Node fans the
            // same `data` event to both listeners, so every key (Esc/Enter/
            // printable) would be handled twice: once by the popup and once
            // by handleInputToken — which aborts the turn on Esc and pollutes
            // the composer draft / queue on Enter. Claim the keyboard here so
            // handleInputToken drops all keys while the popup is open.
            modalOwnsKeyboard = true;
            try {
              return await dialogHost.run((anchor) =>
                runAskChoiceDialog({
                  request: req,
                  input: input as NodeJS.ReadStream,
                  output: output as NodeJS.WritableStream,
                  ...anchor,
                }),
              );
            } catch {
              return { kind: "cancelled" };
            } finally {
              modalOwnsKeyboard = false;
            }
          }
        : undefined;
    try {
      activeTurnAbort = new AbortController();
      activeTurnEpoch = myEpoch;
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
          ...(requestUserChoice ? { requestUserChoice } : {}),
          abortSignal: activeTurnAbort.signal,
          pastedTextStore: pasteStore,
          activityReporter,
          onAgentRunStatus: (snapshot) => {
            if (snapshot) {
              activityIndicator.updateAgentRun(snapshot);
              // run 进面板的唯一入口就在这里，所以轮询器也只在这里起表；
              // 它自己在没有活跃 run 时会停。
              runRegistryPoller.ensureRunning();
            } else {
              activityIndicator.clearAgentRun();
            }
          },
        }
      );
      // 强制收尾保护：第二次 Esc 已把 activeTurnAbort 置 null、busyLock 解除、
      // 打印过 forceStopped 提示。runAgentChat 现在才返回 —— 这段迟到返回值
      // 必须整体丢弃：不读已 null 的 activeTurnAbort（会 NPE）、不重复打印
      // turnStopped、不重绘（用户可能已在输入新一轮）。用 epoch 比对而非全局
      // forcedStop：强制停止后用户可能已发起新 turn 并重置 forcedStop=false，
      // 旧 turn 靠 myEpoch === forcedStopEpoch 识别自己被强制过。
      // dialogId/turnTokens 的状态折叠仍可安全执行（纯数据，不碰 UI 锁）。
      const wasForceStopped = forcedStopEpoch === myEpoch;
      if (wasForceStopped) {
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
                  dialogLabel: runResult.title || runResult.dialogId,
                  ...(runResult.title ? { dialogTitle: runResult.title } : {}),
                }
              : {}),
            ...(runResult.turnTokens ? { turnTokens: runResult.turnTokens } : {}),
            ...(runResult.cachedMemoryOverlay !== undefined ? { cachedMemoryOverlay: runResult.cachedMemoryOverlay } : {}),
          };
        }
        scheduleTitlePatchSync(runResult);
        return { ok: false, aborted: true };
      }
      const wasAborted = activeTurnAbort.signal.aborted;
      activeTurnAbort = null;
      if (
        shouldEmitTerminalBell({
          wasAborted,
          streamInterrupted: runResult.streamInterrupted,
          exitCode: runResult.exitCode,
          interactive: isInteractiveInput(input),
        })
      ) {
        emitTerminalBell(output);
      }
      if (isInteractiveInput(input)) {
        finalizeCurrentTurn(history);
        flushPendingRender();
        renderHistoryToOutput();
        if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
      }
      if (wasAborted) {
        if (runResult.pendingToolName) {
          // 协作式中止时工具仍在跑：localLoop 放弃等待但工具可能已在后台
          // 完成，其结果不会进入本次对话历史。告知工具名，语气正常。
          emitCommandOutput(t("turnStoppedToolPending", runResult.pendingToolName));
        } else {
          emitCommandOutput(t("turnStopped"));
        }
      }
      if (runResult.dialogId || runResult.turnTokens || runResult.contextWindow) {
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
                dialogLabel: runResult.title || runResult.dialogId,
                ...(runResult.title ? { dialogTitle: runResult.title } : {}),
              }
            : {}),
          ...(runResult.turnTokens ? { turnTokens: runResult.turnTokens } : {}),
          ...(runResult.contextWindow
            ? { contextWindow: runResult.contextWindow }
            : {}),
          // input_tokens 是累计上下文输入（含历史消息），把它持久化到
          // estimatedContextTokens：下一轮若 provider 不返回 usage，context
          // chip 仍显示真实累计占用而不是回退到启动时的静态估算。
          ...(runResult.turnTokens && runResult.turnTokens.input > 0
            ? { estimatedContextTokens: runResult.turnTokens.input }
            : {}),
          ...(runResult.cachedMemoryOverlay !== undefined ? { cachedMemoryOverlay: runResult.cachedMemoryOverlay } : {}),
        };
      }
      scheduleTitlePatchSync(runResult);
      // 把失败原因翻成人话：余额 / 额度 / 「对话已保留」/ 「本轮未入档」。
      // 用户预期是：屏幕上看得见的上一句，下一句「继续」不能变成失忆新开场。
      if (!wasAborted && runResult.exitCode !== 0) {
        if (isBalanceExhaustedError(runResult.localError) && runResult.dialogId) {
          emitCommandOutput(t("balanceExhaustedHint"));
        } else if (isQuotaExhaustedError(runResult.localError)) {
          emitCommandOutput(t("quotaExhaustedHint"));
        } else if (runResult.dialogId) {
          emitCommandOutput(t("dialogPreservedHint"));
        } else {
          emitCommandOutput(t("dialogNotSavedHint"));
        }
      }
      return { ok: !wasAborted, aborted: wasAborted };
    } finally {
      activityIndicator.stop();
      activeTurnAbort = null;
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

  // Abort the in-flight turn so the queue head drains immediately. Shared by
  // the empty-Enter-while-busy preempt and the Ctrl+S flush shortcut so the
  // "arm preempt, then abort" two-step lives in exactly one place.
  const preemptAndAbortForDrain = (binding: ChatQueueTuiBinding): void => {
    if (binding.preemptForDrain() && activeTurnAbort) {
      activeTurnAbort.abort();
    }
  };

  const emitCommandOutput = (text: string, command = "") => {
    if (!text) return;
    if (!isInteractiveInput(input)) {
      output.write(`${text}\n`);
      return;
    }
    history.followBottom = true;
    appendLocalTurn(history, command, text);
    renderHistoryToOutput();
    if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
  };

  const persistExplicitAgentSwitch = (previousAgentKey: string) => {
    if (state.agentKey === previousAgentKey) return false;
    persistAgentSelection(
      state,
      options.env ?? process.env,
      options.saveAgentSelection,
    );
    return true;
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
    //
    // 非 chat 的 slash 命令统一走 local turn：命令行 + 输出合并成一条
    // role="local" 的回显，与 user/assistant 对话视觉区分，翻历史不再
    // 把 /switch 这类命令伪装成一轮对话。action 类命令（pick-agent 等）
    // 无 output 时不写 history。/exit 的 "bye" 也不进 history——退出后
    // 历史立即销毁，写 local turn 纯浪费且可能被清屏前闪烁。
    //
    // 非交互模式（管道/脚本）下仍需输出 result.output，但走 emitCommandOutput
    // 内部的 output.write 分支（不写 history），command 传空因为非交互模式
    // 没有"命令回显"的视觉概念。
    const interactive = isInteractiveInput(input);

    if (
      result.action?.type !== "chat" &&
      result.action?.type !== "exit" &&
      result.output
    ) {
      emitCommandOutput(result.output, interactive ? line.trim() : "");
    }

    if (state.agentKey !== previousAgentKey) {
      // 用户显式切换 agent（/agent <name>、/switch <name> 或 picker）：
      // 清掉这条对话首轮 auto-route 的缓存，否则下一轮会被缓存切回原
      // agent（典型场景：原 agent 429 后想换一个）。判定只看 agentKey 是否
      // 变化，不耦合 "Switched to " 这类输出文案——文案一旦 i18n 化或调整，
      // 字符串前缀判定就会漏掉切换、导致缓存不清、切换「不生效」回归。
      persistExplicitAgentSwitch(previousAgentKey);
    }

    if (result.action?.type === "exit") {
      // "bye" 作为退出前最后一帧的视觉确认，直接 output.write 而不进
      // history——退出后 history 立即销毁，写 local turn 没有意义。
      if (result.output) output.write(`${result.output}\n`);
      return true;
    }

    if (result.action?.type === "clear") {
      if (result.action.dialogId) {
        const authToken = resolvePlatformAuthToken(options.env ?? {});
        try {
          await deleteDbRecord({
            // The messages delete endpoint expects the bare dialogId; dialogKey
            // is the persisted dialog record key and has a different prefix.
            dbKey: result.action.dialogId,
            deleteOptions: { type: "messages" },
            authToken,
            fetchImpl,
            serverUrl: state.serverUrl,
          });
          emitCommandOutput(t("clearedDialog"));
        } catch (error) {
          emitCommandOutput(`[nolo] Clear failed: ${toErrorMessage(error)}\n`);
          return false;
        }
      }
      clearCollapsedPasteStore(pasteStore);
      // Clear removes the persisted messages and clears the dialog identity
      // (like /new), so the next turn starts a fresh dialog instead of
      // continuing the cleared one.
      // Drop usage-derived context immediately so the composer reflects the
      // empty dialog before the next turn starts.
      state = {
        ...state,
        turnTokens: undefined,
        cachedMemoryOverlay: undefined, // 新对话重新加载记忆
        estimatedContextTokens: estimateDefaultCliContextTokens({
          cwd: state.cwd,
          agentKey: state.agentKey,
          userLanguage: state.userLanguage,
          ...resolveAgentModelIdentity({
            agentKey: state.agentKey,
            agentName: state.agentName,
          }),
        }),
      };
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
      const authToken = resolvePlatformAuthToken(options.env ?? {});
      const compactStart = Date.now();
      try {
        const compactResult = await runner({
          serverUrl: state.serverUrl,
          authToken,
          dialogId: result.action.dialogId,
          summaryLlmCaller: options.summaryLlmCaller,
        });
        const elapsedSec = ((Date.now() - compactStart) / 1000).toFixed(1);
        state = {
          ...state,
          dialogId: compactResult.dialogId,
          dialogKey: compactResult.dialogKey,
          dialogLabel: compactResult.dialogId,
          dialogTitle: state.dialogTitle,
          // Compact forks into a fresh dialog that only inherits the summary,
          // not the full message history. Drop usage-derived context so the
          // composer chip falls back to the default CLI surface estimate and
          // the context percentage visibly drops. Mirrors the /clear reset.
          turnTokens: undefined,
          cachedMemoryOverlay: undefined, // compact 创建新 dialog，重新加载记忆
          estimatedContextTokens: estimateDefaultCliContextTokens({
            cwd: state.cwd,
            agentKey: state.agentKey,
            userLanguage: state.userLanguage,
            ...resolveAgentModelIdentity({
              agentKey: state.agentKey,
              agentName: state.agentName,
            }),
          }),
        };
        const elapsed = `${elapsedSec}s`;
        const message = compactResult.summaryGenerated
          ? compactResult.compactedMessageCount > 0
            ? t(
                "compactSuccessWithCount",
                result.action.dialogId,
                compactResult.dialogId,
                elapsed,
                String(compactResult.compactedMessageCount),
              )
            : t(
                "compactSuccess",
                result.action.dialogId,
                compactResult.dialogId,
                elapsed,
              )
          : t(
              "compactForked",
              result.action.dialogId,
              compactResult.dialogId,
              elapsed,
            );
        output.write(`${message}\n`);
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

    if (result.action?.type === "theme-refresh") {
      // Re-probe the terminal background on demand (OSC 11) so a runtime
      // theme switch in Ghostty et al. is picked up by the internal palette.
      // emitCommandOutput renders the history and repaints the composer with
      // the updated brightness, so no extra repaint is needed here.
      const detected = await detectTerminalBackground({
        stdin: input as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void },
        stdout: output as NodeJS.WritableStream & { isTTY?: boolean },
        allowSystemFallback: true,
      });
      if (detected && applyDetectedBackground(detected)) {
        emitCommandOutput(t("themeRefreshed", detected.brightness));
      } else if (detected) {
        // Already matched — still echo the current brightness for the user.
        emitCommandOutput(t("themeRefreshed", detected.brightness));
      } else {
        emitCommandOutput(t("themeRefreshFailed"));
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
            contextWindow: resolveAgentContextWindow({
              agentKey: pickResult.key,
              agentName: pickResult.name,
              model: pickResult.model,
            }),
            estimatedContextTokens: estimateDefaultCliContextTokens({
              cwd: state.cwd,
              agentKey: pickResult.key,
              agentName: pickResult.name,
              model: pickResult.model,
              userLanguage: state.userLanguage,
            }),
            ...(pickResult.apiSource ? { apiSource: pickResult.apiSource } : {}),
            cachedMemoryOverlay: undefined, // 切换 agent 后重新加载记忆
          };
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

    if (result.action?.type === "set-altscreen") {
      // Both helpers are idempotent and no-op on non-TTY, so a repeated
      // /altscreen on|off costs nothing. Re-installing the restore handlers on
      // re-entry keeps the exit/signal path pointed at the current output.
      if (result.action.enabled) {
        enterAltScreen(output);
        installAltScreenRestoreHandlers(output);
      } else {
        leaveAltScreen(output);
      }
      // The freshly switched buffer is blank — repaint or the user stares at
      // an empty screen until the next event.
      resetHistoryFrameDiffCache(output);
      renderHistoryToOutput();
      fixedInput.repaint(buffer, cursorPos);
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
            options.dialogHistoryLoader ?? loadDialogHistoryForDisplay
          )({
            dialog: pickResult.dialog,
            env: options.env ?? process.env,
          });
          const restored = loadedTurns.slice(-MAX_TUI_HISTORY_TURNS);
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
            dialogLabel: pickResult.dialog.title || pickResult.dialog.id,
            dialogTitle: pickResult.dialog.title,
            turnTokens: undefined,
            cachedMemoryOverlay: undefined, // 切换对话后重新加载记忆
          };
          clearCollapsedPasteStore(pasteStore);
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

    if (result.action?.type === "shell-command") {
      const shellCmd = result.action.command;
      if (!shellCmd) {
        emitCommandOutput("[nolo] Error: No command specified after !");
      } else {
        emitCommandOutput(`Executing: ${shellCmd}`);
        try {
          const shellInvocation =
            process.platform === "win32"
              ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", shellCmd]
              : ["/bin/sh", "-c", shellCmd];
          const proc = spawnRunner({
            cmd: shellInvocation,
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
      if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
    }

    return false;
  };

  if (isInteractiveInput(input)) {
    input.setRawMode(true);
    output.write("\x1b[?2004h");
    let busy = false;
    let done = false;
    let resolveDone: (() => void) | null = null;
    // NOTE: do NOT redeclare `buffer` here. The composer draft lives in the
    // outer scope (hoisted above) on purpose: runSubmittedLine's streaming
    // callback and the activity spinner timer repaint the composer from that
    // binding while a turn runs. Shadowing it with a block-local `let buffer`
    // (as this used to do) decoupled the two: onKey wrote the draft into the
    // inner binding while every streaming/activity repaint read the outer one,
    // which stayed "" forever — so during a loop the composer kept snapping
    // back to the placeholder and hid what the user was typing (the submit
    // path still read the inner buffer, so input "worked" but was invisible).
    const baseFixedInput = createFixedInput(output, {
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

        return base;
      },
      getActivityLines: () =>
        activityIndicator.getActivityLines(resolveCliColorEnabled()),
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
      onInputLinesChange: () => {
        // composer 高度变化（活动行首次出现：3→4 行）时补一次历史重绘。
        // renderHistoryToOutput 内部有 syncingLayout 卫兵防重入。
        renderHistoryToOutput();
      },
    });
    fixedInput = {
      ...baseFixedInput,
      repaint(draft, cursorPos) {
        syncWindowTitle();
        return baseFixedInput.repaint(draft, cursorPos);
      },
    };
    fixedInput.init();
    const paintFrame = (draft: string) => {
      renderHistoryToOutput();
      fixedInput.repaint(draft, cursorPos);
    };
    const onResize = () => {
      if (done) return;
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
        fixedInput.repaint(buffer, cursorPos);
        return;
      }
      flushPendingRender();
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
      sessionEnded = true; // signal in-flight async git refresh to drop its repaint
      if (autoThemeTimer !== null) {
        clearInterval(autoThemeTimer);
        autoThemeTimer = null;
      }
      // run 停靠区的 timer 跨 turn 存活，只有会话退出才该停——否则 /exit 之后
      // 它还在往一个已经不归自己管的终端上重绘。
      runRegistryPoller.dispose();
      runCompletionWatcher.dispose();
      activityIndicator.dispose();
      resolveDone?.();
      clearCollapsedPasteStore(pasteStore);
      resizeTarget.off?.("resize", onResize);
      input.off("data", onData);
      onData.destroy();
      output.write("\x1b[?2004l");
      output.write("\x1b[?25h\x1b[?2026l");
      input.setRawMode?.(false);
    };
    // actionGate / 破坏性操作确认的交互处理器曾内联在三处（busy 提交、空闲
    // 手动 drain、直接发送），逐字重复。抽成一份三条路径共用：行为完全一致
    // （modalOwnsKeyboard 的占锁/释放、composer 的 pause/resume、raw token
    // 注册），改一处即三处生效。
    const buildInteractiveTurnHandlers = () => {
      const actionGateHandler = async (gate: LocalAgentActionGate) => {
        modalOwnsKeyboard = true;
        try {
          return await waitForRawActionGate(input, output, gate, spawnRunner, {
            beforeSubprocess: () => fixedInput.pause(),
            afterSubprocess: () => fixedInput.resumeFromSubprocess(),
            registerToken: (handler) => { rawActionGateTokenHandler = handler; },
          });
        } finally {
          modalOwnsKeyboard = false;
        }
      };
      const confirmDestructiveAction = async (request: PermissionRequest) => {
        modalOwnsKeyboard = true;
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
          modalOwnsKeyboard = false;
        }
      };
      return { actionGateHandler, confirmDestructiveAction };
    };
    // 空闲时把一段文本作为新 turn 直接跑。两个调用方：Enter 键的空闲手动
    // drain（空 Enter / Ctrl+S 落到这里的队首）和 run 终态唤醒。busy 标志、
    // enterOutputMode、notifyTurnEnd、失败时 emitCommandOutput(turnFailed)
    // 与直接发送路径保持同一份实现，不复制漂移。调用方必须保证当前空闲。
    const runIdleTextTurn = async (inputMsg: TurnRequest | InternalTurnEvent | string): Promise<void> => {
      const req = createTurnRequest(inputMsg);
      const { actionGateHandler, confirmDestructiveAction } = buildInteractiveTurnHandlers();
      const binding = ensureChatQueueBinding(actionGateHandler, confirmDestructiveAction);
      binding.notifyTurnStart();
      busy = true;
      fixedInput.enterOutputMode(req.text);
      try {
        const outcome = await runOneAgentTurn(
          req,
          [],
          actionGateHandler,
          confirmDestructiveAction,
        );
        await binding.notifyTurnEnd(outcome);
      } catch (err) {
        await binding.notifyTurnEnd({ ok: false, aborted: false });
        emitCommandOutput(
          `${t("turnFailed")}${err instanceof Error && err.message ? `\n${err.message}` : ""}`,
        );
      } finally {
        busy = false;
      }
      refreshGitStatus();
      flushPendingRender();
      fixedInput.exitOutputMode(buffer, cursorPos);
    };
    runWakeHandler = (event: InternalTurnEvent | string) => {
      if (done) return;
      if (busy || fixedInput.isPaused()) {
        const { actionGateHandler, confirmDestructiveAction } = buildInteractiveTurnHandlers();
        ensureChatQueueBinding(actionGateHandler, confirmDestructiveAction).enqueue(event);
        if (fixedInput.active && !fixedInput.isPaused()) {
          fixedInput.repaint(buffer, cursorPos);
        }
        return;
      }
      void runIdleTextTurn(event).catch((err) => {
        emitCommandOutput(
          `${t("turnFailed")}${err instanceof Error && err.message ? `\n${err.message}` : ""}`,
        );
      });
    };
    const handleInputToken = async (sequence: string) => {
      if (done) return;
      // While a modal (raw action gate OR ask_choice popup) owns the
      // keyboard, that modal's own `data` listener owns the keyboard. Drop
      // everything else so random keys do not accumulate in the composer
      // draft buffer and corrupt the next submitted line, and so Esc meant
      // to cancel an ask_choice popup does not also abort the running turn.
      if (modalOwnsKeyboard) {
        rawActionGateTokenHandler?.(sequence);
        return;
      }
      // While an agent turn is running we let the user keep typing into the
      // docked composer (draft buffer) but ignore submit so a second turn
      // cannot race the in-flight one. The draft is preserved and shown
      // once the turn finishes via fixedInput.exitOutputMode(buffer).
      // Ctrl+S flushes every queued follow-up as one merged message. The raw
      // byte is always swallowed here (even with an empty queue) so it never
      // falls through to applyTuiInputKey and gets typed into the draft as a
      // literal control char (review finding: empty-queue Ctrl+S leaked into
      // the composer buffer).
      //   - busy: snapshot+clear the queue, re-enqueue the merged text as the
      //     sole head, preempt the in-flight turn so the drain cascade sends
      //     it immediately. The draft is kept (the turn owns the screen).
      //   - idle: the composer draft is folded into the merge too (it is
      //     unsent content just like the queue), then the empty-Enter manual
      //     drain path sends the merged text as a fresh turn. Folding the
      //     draft here — instead of recursing with a possibly-non-empty
      //     buffer — avoids the trap where a stray draft would be submitted
      //     by the synthetic Enter while the merge stayed stranded in the
      //     queue.
      if (sequence === CTRL_S) {
        if (!chatQueueBinding || chatQueueBinding.queueLength() === 0) {
          // Nothing to flush: swallow the key so \x13 is never typed into the
          // draft as a literal control character.
          return;
        }
        const flushCount = chatQueueBinding.queueLength();
        const merged = chatQueueBinding.snapshotAndClearQueue();
        if (!merged) return;
        // Idle: fold the composer draft into the merge so "Ctrl+S = send
        // everything pending right now" holds even when the user is mid-type.
        // Busy keeps the draft (the turn owns the screen; the draft is
        // preserved and editable once the turn ends).
        const draftIncluded = !busy && buffer.trim() !== "";
        const fullText = draftIncluded ? `${buffer}\n${merged}` : merged;
        chatQueueBinding.enqueue(fullText);
        // Use a busy-aware message so the busy path does not contradict the
        // subsequent "Stopped this reply." line (review finding: two
        // contradictory toasts). The idle path is plain "flushed N as one".
        const totalCount = flushCount + (draftIncluded ? 1 : 0);
        emitCommandOutput(
          t(busy ? "flushQueuedBusyHint" : "flushQueuedIdleHint", String(totalCount)),
        );
        if (busy) {
          preemptAndAbortForDrain(chatQueueBinding);
          return;
        }
        // Idle: clear the now-merged draft, then reuse the empty-Enter
        // manual-drain path below to send it as a fresh turn.
        buffer = "";
        cursorPos = 0;
        if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
        return handleInputToken("\r");
      }
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
      // sequences), so this cannot swallow other keys. When the queue has
      // staged follow-ups, arm stop-preempt so the abort preserves them
      // (instead of the normal "abort abandons follow-ups" contract); the
      // user stopped the current reply but did not abandon what they queued.
      //
      // 两次 Esc：
      // 1) 第一次：abort 协作停止，同帧把活动行切到「停止中」文案让用户立刻
      //    看到反馈（owner 报的 bug：按了没反应、要按好几次）。链路 unwind 需
      //    要时间，turnStopped 要等 await 返回才打印。
      // 2) 第二次（已 isStopping）：不再等链路，直接把 UI 交还用户——
      //    activityIndicator.stop()、forcedStop=true、activeTurnAbort=null、
      //    打印 forceStopped 提示、busyLock 解除、重绘 composer。迟到的
      //    runAgentChat 返回值由 runOneAgentTurn 里的 forcedStop 分支丢弃。
      if (busyLock && sequence === "\x1b" && activeTurnAbort) {
        if (activityIndicator.isStopping()) {
          // 第二次 Esc = 强制收尾。
          forcedStop = true;
          forcedStopEpoch = activeTurnEpoch;
          activityIndicator.stop();
          activeTurnAbort.abort();
          activeTurnAbort = null;
          activeTurnEpoch = 0;
          busy = false;
          emitCommandOutput(t("forceStopped"));
          flushPendingRender();
          renderHistoryToOutput();
          if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);
          return;
        }
        // 第一次 Esc = 协作停止 + 即时反馈。
        const stopBinding = chatQueueBinding;
        if (stopBinding && stopBinding.queueLength() > 0) {
          stopBinding.preemptForStop();
        }
        activityIndicator.markStopping();
        activeTurnAbort.abort();
        return;
      }
      const result = applyTuiInputKey(buffer, sequence, {}, cursorPos, {
        pasteStore,
      });
      if (result.redraw) {
        resetHistoryFrameDiffCache(output);
        renderHistoryToOutput();
        if (fixedInput.active) fixedInput.repaint(buffer, cursorPos, true);
        return;
      }
      if (result.abort) {
        fixedInput.disable();
        finish();
        return;
      }
      if (result.submit !== undefined) {
        // Replace UI-only paste chips with compact model references. The full
        // body is expanded only at an HTTP/persistence boundary or on demand
        // through readPastedText, so every provider round avoids replaying it.
        const submittedText = replaceCollapsedPastesWithReferences(
          result.submit,
          pasteStore,
        );
        const submittedTrimmed = submittedText.trim();
        // `busy` means an agent turn is occupying the composer. Slash/shell
        // commands (including /history) may await a picker or subprocess, but
        // they must not make a later /exit look like a queued chat message.
        const startsChatTurn =
          submittedTrimmed.length > 0 &&
          !submittedTrimmed.startsWith("/") &&
          !submittedTrimmed.startsWith("!");
        if (busyLock) {
          // While an agent turn is running, Enter does not start a new turn.
          // Instead, route the draft through the shared queue resolver: pure
          // text is enqueued for auto-send after the turn; slash commands and
          // attachments are surfaced as a brief notice (the user can retry
          // once the turn ends). The draft is cleared only on a successful
          // enqueue.
          const trimmedText = submittedText.trim();
          // While a turn runs, a few slash commands are handled locally right
          // now instead of being queued. Queuing them is wrong: the queue
          // drains its head by feeding the raw text to the agent runner as a
          // chat message, so a queued `/switch foo` would be sent to the model
          // as conversation text instead of switching the model. These
          // commands also MUST NOT touch the shared history state machine:
          // while a turn runs the assistant stream owns currentRole /
          // currentContent, and calling startTurn("user") here would
          // prematurely finalize the half-streamed reply (its tail chunks
          // would land under currentRole===null and be dropped by
          // finalizeCurrentTurn). So we route them through the transient
          // render channel: run handleTuiInput (which only mutates local TUI
          // state + returns output for these commands, never a chat action)
          // and write straight to the output stream. The next streaming
          // repaint overwrites it, which is fine for an ephemeral notice.
          const busySlashCommand = trimmedText.split(/\s+/)[0]?.toLowerCase();
          const isBusyLocalSlash =
            busySlashCommand === "/context" ||
            busySlashCommand === "/ctx" ||
            busySlashCommand === "/switch" ||
            busySlashCommand === "/theme" ||
            busySlashCommand === "/density" ||
            busySlashCommand === "/runtime" ||
            busySlashCommand === "/tools" ||
            busySlashCommand === "/tasks" ||
            busySlashCommand === "/jobs" ||
            busySlashCommand === "/procs" ||
            busySlashCommand === "/agents" ||
            busySlashCommand === "/doc" ||
            busySlashCommand === "/skill" ||
            busySlashCommand === "/customize" ||
            busySlashCommand === "/login" ||
            busySlashCommand === "/profile" ||
            busySlashCommand === "/version";
          if (isBusyLocalSlash) {
            releaseCollapsedPasteReferences(submittedText, pasteStore);
            buffer = "";
            cursorPos = 0;
            if (fixedInput.active) fixedInput.repaint(buffer, cursorPos);

            const beforeAgentKey = state.agentKey;
            const res = handleTuiInput(submittedText, state);
            if (res.action?.type === "theme-refresh") {
              state = res.nextState;
              const detected = await detectTerminalBackground({
                stdin: input as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void },
                stdout: output as NodeJS.WritableStream & { isTTY?: boolean },
                allowSystemFallback: true,
              });
              let refreshMsg = "";
              if (detected && applyDetectedBackground(detected)) {
                refreshMsg = t("themeRefreshed", detected.brightness);
              } else if (detected) {
                refreshMsg = t("themeRefreshed", detected.brightness);
              } else {
                refreshMsg = t("themeRefreshFailed");
              }
              if (refreshMsg) {
                output.write(`${refreshMsg}\n`);
              }
            } else if (res.action) {
              // `/switch` with no target (interactive picker) and `/switch
              // list` need to take over the screen, which races the in-flight
              // streaming repaint. Don't open them while busy and don't queue
              // them either: surface a one-line notice telling the user how
              // to switch without the picker (the change takes effect on the
              // next turn, not the in-flight one).
              output.write(
                "Model picker isn't available while a reply is running. " +
                  "Use `/switch <name>` to switch now (takes effect on the " +
                  "next turn), or wait for the reply to finish.\n",
              );
            } else {
              state = res.nextState;
              let msg = res.output;
              if (
                busySlashCommand === "/switch" &&
                persistExplicitAgentSwitch(beforeAgentKey)
              ) {
                // The switch succeeded. It can't affect the in-flight turn
                // (its model/provider were captured at turn start), so it
                // takes effect on the next turn / loop iteration. Warn that
                // switching mid-conversation re-sends the context to the new
                // model and therefore may burn extra tokens.
                const hint =
                  "Note: the new model takes effect on the next turn. " +
                  "Switching models may consume more tokens because the " +
                  "conversation context is re-sent to the new model.";
                msg = msg ? `${msg}\n${hint}` : hint;
              }
              if (msg) {
                output.write(`${msg}\n`);
              }
            }
            return;
          }
          const { actionGateHandler, confirmDestructiveAction } =
            buildInteractiveTurnHandlers();
          const binding = ensureChatQueueBinding(actionGateHandler, confirmDestructiveAction);
          const decision = binding.resolveSubmit({
            text: submittedText,
            isRunning: true,
          });
          if (decision.kind === "queue-text") {
            binding.enqueue(decision.text);
            buffer = "";
            cursorPos = 0;
            fixedInput.repaint(buffer, cursorPos);
          } else if (decision.kind === "queue-blocked") {
            // Attachments / mentions can't be queued yet; keep the draft so
            // the user can resend after the turn. No destructive action.
          } else if (
            decision.kind === "noop" &&
            !submittedText.trim() &&
            binding.queueLength() > 0
          ) {
            // Empty Enter while busy with a non-empty queue: preempt the
            // in-flight turn so the queued head drains immediately instead
            // of waiting for the turn to finish. Arm the binding's preempt
            // flag (so the upcoming aborted turn-end is reinterpreted as a
            // clean end and drains rather than clearing the queue), then
            // abort the current turn. The turn's own finally will call
            // notifyTurnEnd, which drives the drain cascade.
            preemptAndAbortForDrain(binding);
          }
          // arm-fresh-dialog / compact-blocked / noop / multi-image-blocked
          // are all intentionally no-ops while busy: the draft is preserved
          // and the user can act on it once the turn completes.
          return;
        }
        // Empty Enter while idle with a residual queue (e.g. a previous turn
        // failed and kept the queue): manually drain the head as a fresh
        // turn. Reuses the same runOneAgentTurn + notifyTurnEnd path as a
        // direct send so the queue core stays consistent. Non-empty drafts
        // fall through to runSubmittedLine as before.
        if (!submittedText.trim() && chatQueueBinding && chatQueueBinding.queueLength() > 0) {
          const { actionGateHandler, confirmDestructiveAction } = buildInteractiveTurnHandlers();
          const manualBinding = ensureChatQueueBinding(actionGateHandler, confirmDestructiveAction);
          const drainedText = manualBinding.drainHeadForManualTurn();
          if (drainedText !== null) {
            // 空 Enter 进来的，草稿本来就是空的/纯空白，清掉再进 output 模式。
            // turn 执行本体走共享的 runIdleTextTurn（与 run 终态唤醒同一份）。
            buffer = "";
            cursorPos = 0;
            await runIdleTextTurn(drainedText);
            return;
          }
        }
        busy = startsChatTurn;
        buffer = "";
        cursorPos = 0;
        // Note: we intentionally keep the `data` listener attached. During the
        // agent turn the user can still type into the composer; submit is
        // gated by `busy` above. This avoids tearing the input chrome down
        // and lets the draft persist across the turn.
        // `submittedText` contains compact paste references; the selected
        // runtime expands or reads the full body at the appropriate boundary.
        fixedInput.enterOutputMode(submittedText);
        // `busy` gates whether Enter starts a turn or queues. It MUST be
        // released no matter how runSubmittedLine settles; leaving it stuck
        // (an unhandled throw used to do exactly that) silently routes every
        // later Enter into the queue with no way to drain. The finally is the
        // last-resort guard; runSubmittedLine also handles turn errors itself.
        let shouldExit = false;
        try {
          const { actionGateHandler, confirmDestructiveAction } = buildInteractiveTurnHandlers();
          shouldExit = await runSubmittedLine(
            submittedText,
            actionGateHandler,
            confirmDestructiveAction,
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
        // Refresh git branch/dirty counts after a turn: the agent may have
        // checked out a branch, committed, or written files during the run, so
        // the snapshot taken at session start (createInitialTuiState) is stale.
        // Mirrors the init gate (NOLO_CLI_GIT_STATUS === "0" disables).
        // Async so we don't block the event loop (chip updates one tick later).
        refreshGitStatus();
        flushPendingRender();
        fixedInput.exitOutputMode(buffer, cursorPos);
        return;
      }
      buffer = result.buffer;
      cursorPos = result.cursorPos ?? buffer.length;
      fixedInput.repaint(buffer, cursorPos);
    };
    const onData = createRawInputDecoder((token) => {
      void handleInputToken(token);
    });
    try {
      input.on("data", onData);
      fixedInput.repaint(buffer, cursorPos);
      refreshGitStatus();
      await new Promise<void>((resolve) => {
        resolveDone = resolve;
        if (done) resolve(); // finish() may have run before we started waiting
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
    const registry = getProcessRegistry();
    const persistentCount = registry.list().filter((p) => p.persist && p.status === "running").length;
    registry.stopAll();
    if (persistentCount > 0) {
      output.write(`[nolo] ${t("persistentProcessesLeft", String(persistentCount))}\n`);
    }
    // 非交互（readline）路径结束时不走 interactive 的 finish()，这里同样
    // 标记 session 结束，让迟到的异步回调（如更新检查）不再触发渲染写入
    // 已关闭的 stdout/pipe。
    sessionEnded = true;
    rl.close();
  }
}
