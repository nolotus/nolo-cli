import { LOCAL_AGENT_CONFIG_MISSING_CODE } from "../agent-runtime/localLoop";
import { NOLO_PROJECT_MANAGER_AGENT_KEY } from "../agentAliases";
import type {
  LocalAgentActionGate,
  LocalAgentLoopEvent,
  LocalAgentToolEvent,
} from "../agent-runtime/localLoop";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import type {
  AgentRuntimeHostAdapter,
  AgentRuntimeRequestedMode,
  AgentRuntimeToolResult,
} from "../agentRuntimeLocal";
import {
  createCliCallAgentToolExecutor,
  createCliLocalRuntimeAdapter,
  isBuiltinNoloAgentRef,
} from "./localRuntimeAdapter";
import type {
  LocalAgentTurnInput,
  LocalAgentTurnResult,
} from "../agent-runtime/localLoop";
import type { CliFetchImpl } from "../cliFetch";
import { createStreamingTextWriter } from "./streamingOutput";
import {
  createRenderAwareStreamWriter,
  formatAssistantDisplay,
  resolveRenderDisplayMode,
} from "./assistantOutput";
import {
  createThinkingAwareStreamFilter,
  formatAssistantTextForCli,
  resolveThinkingDisplayMode,
} from "./thinkingOutput";
import { buildTurnTokenUsage, type TurnTokenUsage } from "./tokenUsage";
import {
  createToolEventFormatter,
  resolveToolDisplayMode,
  shouldEmitToolEvents,
} from "./toolOutput";
import {
  type DispatchPlan,
  resolveAuthToken,
  isMachineBoundLocalhostCustomProvider,
  resolveBoundMachineId,
  detectCurrentMachineId,
  CLI_PROVIDER_NAMES,
  isCliProviderAgentConfig,
} from "./agentRunTypes";
import { isGatewayHttpStatus } from "../core/gatewayHttpStatus";
import { normalizeAgentHandle } from "../core/agentHandle";
import { ulid } from "ulid";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedString } from "../core/trimmedString";
import { toErrorMessage } from "../core/errorMessage";

/** Local loop is heavy; load only when a local turn actually runs. */
async function loadRunLocalAgentTurn() {
  const { runLocalAgentTurn } = await import("../agentRuntimeLocal");
  return runLocalAgentTurn;
}

type EnvLike = Record<string, string | undefined>;

type OutputLike = {
  write(chunk: string): unknown;
};
type AgentRunSubjectRef = {
  kind: string;
  id: string;
  role?: string;
};

type ReviewDecisionStatus = "passed" | "needs_changes" | "blocked";

export type TaskEvidenceInput = {
  rowDbKey: string;
  artifactIds?: string[];
};

export type RunAgentTurnOptions = {
  agentName: string;
  agentKey: string;
  serverUrl: string;
  message: string;
  imageUrls?: string[];
  continueDialogId?: string;
  spaceId?: string;
  category?: string;
  inheritedFromDialogKey?: string;
  parentDialogId?: string;
  parentWakeOnTerminal?: boolean;
  subjectDialogKey?: string;
  subjectRefs?: AgentRunSubjectRef[];
  allowedChildAgentKeys?: string[];
  allowedToolNames?: string[];
  background?: boolean;
  noStream?: boolean;
  scriptDir: string;
  env: EnvLike;
  output: OutputLike;
  runtimeMode?: AgentRuntimeRequestedMode;
  localRuntimeAdapter?: AgentRuntimeHostAdapter;
  localRuntimeAdapterFactory?: (
    env: EnvLike,
    options?: { cwd?: string },
  ) => AgentRuntimeHostAdapter;
  localRuntimeCwd?: string;
  timeoutMs?: number;
  traceTools?: boolean;
  eventsMode?: "jsonl";
  taskEvidence?: TaskEvidenceInput;
  fetchImpl?: CliFetchImpl;
  currentMachineIdResolver?: (env: EnvLike) => Promise<string | undefined>;
  actionGateHandler?: (
    gate: LocalAgentActionGate,
  ) => Promise<AgentRuntimeToolResult | void>;
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /** Local loop lifecycle events; used by the CLI runner to write heartbeat activity to the registry. */
  onLoopEvent?: (event: LocalAgentLoopEvent) => void;
};

export type RunAgentTurnResult = {
  exitCode: number;
  dialogId?: string;
  streamInterrupted?: boolean;
  localError?: unknown;
  turnTokens?: TurnTokenUsage;
};

class Spinner {
  private timer: any = null;
  private startTime = 0;
  private frameIndex = 0;
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private isTTY: boolean;

  constructor(
    private output: OutputLike,
    private text: string,
  ) {
    // Prefer the stream's own TTY flag. History capture streams set isTTY so
    // \\r in-place updates are interpreted; falling back only when unset keeps
    // plain stdout/file mocks working.
    const explicit = (output as { isTTY?: boolean }).isTTY;
    this.isTTY =
      typeof explicit === "boolean" ? explicit : Boolean(process.stdout.isTTY);
  }

  start() {
    if (!this.isTTY) {
      this.output.write(`\n${this.text}\n`);
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.frameIndex = 0;
    this.startTime = Date.now();
    // Take over the cursor role: the spinner becomes the only "alive"
    // indicator while the agent turn is in flight, so a static terminal
    // cursor can no longer be mistaken for a frozen process.
    this.output.write("\x1b[?25l");
    this.output.write(this.renderLine(this.frames[0]));

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.output.write(`\r${this.renderLine(this.frames[this.frameIndex])}`);
    }, 80);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.isTTY) {
      this.output.write("\r\x1b[K");
      this.output.write("\x1b[?25h");
    }
  }

  private renderLine(frame: string): string {
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - this.startTime) / 1000),
    );
    return `\x1b[36m${frame}\x1b[39m ${this.text} (${formatElapsed(elapsedSeconds)})`;
  }
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// Table mutations require the server runtime.
// Read-only queryTableRows is intentionally excluded: local CLI executes it via
// noloWorkspaceTools, so auto mode should not skip local just because it appears
// in the private workspace tool surface.
const SERVER_PLATFORM_TOOL_NAMES = new Set([
  "addTableRow",
  "addTableRows",
  "deleteTableRow",
  "deleteTableRows",
  "updateTableRow",
  "updateTableRows",
]);

const KNOWN_SERVER_PLATFORM_AGENT_KEYS = new Set([
  NOLO_PROJECT_MANAGER_AGENT_KEY,
]);

const KNOWN_SERVER_PLATFORM_AGENT_ALIASES = new Set([
  "code-review",
  "frontend",
  "frontend-agent",
  "frontend-implementer",
  "full-stack",
  "fullstack",
  "nolo code review",
  "nolo fullstack",
  "nolo project manager",
  "nolo reviewer",
  "nolo-code-review",
  "nolo-fullstack",
  "nolo-pm",
  "nolo-project-manager",
  "nolo-reviewer",
  "pm",
  "project-manager",
  "review",
  "reviewer",
]);

export function findServerPlatformTools(toolNames?: string[]) {
  if (!Array.isArray(toolNames)) return [];
  return toolNames.filter((toolName) =>
    SERVER_PLATFORM_TOOL_NAMES.has(toolName),
  );
}

function resolveServerPlatformToolNames(agentConfig: any) {
  return findServerPlatformTools([
    ...(Array.isArray(agentConfig?.toolNames) ? agentConfig.toolNames : []),
    ...(Array.isArray(agentConfig?.runtimeToolPolicy?.agentTools)
      ? agentConfig.runtimeToolPolicy.agentTools
      : []),
  ]);
}

function isKnownServerPlatformAgent(options: RunAgentTurnOptions) {
  if (KNOWN_SERVER_PLATFORM_AGENT_KEYS.has(options.agentKey)) return true;
  const normalizedKey = normalizeAgentHandle(options.agentKey);
  return Boolean(
    normalizedKey && KNOWN_SERVER_PLATFORM_AGENT_ALIASES.has(normalizedKey),
  );
}

function shouldShowUsage(env: EnvLike) {
  return env.NOLO_DEBUG === "1" || env.NOLO_SHOW_USAGE === "1";
}
async function resolveCurrentMachineId(options: RunAgentTurnOptions) {
  return options.currentMachineIdResolver
    ? options.currentMachineIdResolver(options.env)
    : detectCurrentMachineId(options.env);
}

function resolveRequestedRuntimeMode(options: RunAgentTurnOptions) {
  const envMode = options.env.NOLO_RUNTIME_MODE;
  if (options.runtimeMode) return options.runtimeMode;
  if (envMode === "local" || envMode === "server" || envMode === "auto")
    return envMode;
  return "auto";
}

function buildDefaultLocalRuntimeAdapter(options: RunAgentTurnOptions) {
  return createCliLocalRuntimeAdapter({
    env: options.env,
    fetchImpl: options.fetchImpl,
    cwd: options.localRuntimeCwd,
    output: options.output,
    ...(options.confirmDestructiveAction
      ? { confirmDestructiveAction: options.confirmDestructiveAction }
      : {}),
  });
}

function resolveLocalRuntimeAdapter(options: RunAgentTurnOptions) {
  return (
    options.localRuntimeAdapter ||
    options.localRuntimeAdapterFactory?.(options.env, {
      cwd: options.localRuntimeCwd,
    }) ||
    buildDefaultLocalRuntimeAdapter(options)
  );
}

async function shouldSkipAutoLocalForServerPlatformTools(
  options: RunAgentTurnOptions,
) {
  if (isBuiltinNoloAgentRef(options.agentKey)) return false;
  if (options.localRuntimeCwd) {
    return false;
  }
  const knownServerPlatformAgent = isKnownServerPlatformAgent(options);
  const adapter = resolveLocalRuntimeAdapter(options);
  if (!adapter) return knownServerPlatformAgent;
  let agentConfig;
  try {
    agentConfig = await adapter.loadAgentConfig(options.agentKey);
  } catch {
    if (knownServerPlatformAgent) {
      options.output.write(
        `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is a known platform agent. ` +
          "Use --local explicitly to force local workspace tools.\n",
      );
      return true;
    }
    return false;
  }
  if (isCliProviderAgentConfig(agentConfig)) {
    const boundMachineId = resolveBoundMachineId(agentConfig);
    if (!boundMachineId) return false;
    const currentMachineId =
      (await resolveCurrentMachineId(options))?.trim() || "";
    if (currentMachineId && currentMachineId === boundMachineId) return false;
    options.output.write(
      `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is bound to ${boundMachineId}` +
        (currentMachineId ? ` and this machine is ${currentMachineId}.` : ".") +
        " Use --local explicitly to force the current machine.\n",
    );
    return true;
  }
  if (knownServerPlatformAgent) {
    options.output.write(
      `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is a known platform agent. ` +
        "Use --local explicitly to force local workspace tools.\n",
    );
    return true;
  }
  if (isMachineBoundLocalhostCustomProvider(agentConfig)) {
    options.output.write(
      `[nolo] auto runtime: skipping local runtime because ${options.agentKey} is a machine-bound localhost custom provider. ` +
        "Use --local explicitly to force the current machine.\n",
    );
    return true;
  }
  const serverTools = resolveServerPlatformToolNames(agentConfig);
  if (serverTools.length === 0) return false;
  options.output.write(
    `[nolo] auto runtime: skipping local runtime because ${options.agentKey} declares server platform tools ` +
      `(${serverTools.join(", ")}). Use --local explicitly to force local workspace tools.\n`,
  );
  return true;
}

function buildUserInputContent(message: string, imageUrls: string[] = []) {
  if (imageUrls.length === 0) return message;
  return [
    ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
    ...imageUrls.map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
  ];
}

function buildSubjectRefs(options: RunAgentTurnOptions) {
  const refs: AgentRunSubjectRef[] = [];
  const seen = new Set<string>();
  const pushRef = (ref: AgentRunSubjectRef) => {
    const kind = ref.kind.trim();
    const id = ref.id.trim();
    const role = ref.role?.trim();
    if (!kind || !id) return;
    const key = `${kind}\u0000${id}\u0000${role ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, id, ...(role ? { role } : {}) });
  };
  for (const ref of options.subjectRefs ?? []) pushRef(ref);
  if (options.subjectDialogKey) {
    pushRef({
      kind: "dialog",
      id: options.subjectDialogKey,
      role: "subject",
    });
  }
  if (options.taskEvidence?.rowDbKey) {
    pushRef({
      kind: "table-row",
      id: options.taskEvidence.rowDbKey,
      role: "task",
    });
  }
  for (const artifactId of options.taskEvidence?.artifactIds ?? []) {
    pushRef({
      kind: "artifact",
      id: artifactId,
      role: "evidence",
    });
  }
  return refs.length ? refs : undefined;
}

function formatAssistantResponseForCli(
  text: string,
  options: RunAgentTurnOptions,
) {
  const thinkingMode = resolveThinkingDisplayMode(options.env);
  const renderMode = resolveRenderDisplayMode(options.env);
  return formatAssistantDisplay(
    formatAssistantTextForCli(text, thinkingMode),
    renderMode,
  );
}

function resolveAgentEventMode(options: RunAgentTurnOptions): "text" | "jsonl" {
  if (options.eventsMode === "jsonl") return "jsonl";
  return options.env.NOLO_AGENT_EVENTS === "jsonl" ? "jsonl" : "text";
}

function isMissingLocalAgentConfigError(error: unknown, agentRef: string) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string; agentRef?: string }).code ===
      LOCAL_AGENT_CONFIG_MISSING_CODE &&
    (error as { code?: string; agentRef?: string }).agentRef === agentRef,
  );
}

function formatToolJsonEvent(event: LocalAgentToolEvent) {
  return `${JSON.stringify({
    schemaVersion: 1,
    type: event.type,
    round: event.round + 1,
    tool: event.toolName,
    toolCallId: event.toolCallId,
    ...(event.argumentsPreview ? { argsPreview: event.argumentsPreview } : {}),
    ...(typeof event.elapsedMs === "number"
      ? { elapsedMs: event.elapsedMs }
      : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  })}\n`;
}

function shouldAttemptAutoLocal(options: RunAgentTurnOptions) {
  if (options.localRuntimeAdapter || options.localRuntimeAdapterFactory)
    return true;
  if (
    options.env.NOLO_DISABLE_CLI_WORKSPACE_TOOLS !== "1" &&
    isBuiltinNoloAgentRef(options.agentKey) &&
    resolveAuthToken(options.env)
  ) {
    return true;
  }
  if (
    options.env.NOLO_DISABLE_CLI_WORKSPACE_TOOLS !== "1" &&
    resolveAuthToken(options.env) &&
    !isKnownServerPlatformAgent(options)
  ) {
    return true;
  }
  return Boolean(
    options.env.NOLO_LOCAL_OPENAI_API_KEY ||
    options.env.OPENAI_API_KEY ||
    options.env.NOLO_LOCAL_OPENAI_BASE_URL ||
    options.env.OPENAI_BASE_URL ||
    options.env.NOLO_LOCAL_AGENT_KEY,
  );
}

export function classifyReviewDecisionStatus(
  summary?: string,
): ReviewDecisionStatus | undefined {
  const normalized = summary?.toLowerCase().trim();
  if (!normalized) return undefined;

  const explicit = normalized.match(
    /review\s+decision\s*:\s*(passed|needs_changes|blocked)/,
  );
  if (explicit?.[1]) return explicit[1] as ReviewDecisionStatus;

  if (
    /\b(blocked|cannot review|unable to review)\b|无法审查|阻塞/.test(
      normalized,
    )
  ) {
    return "blocked";
  }
  if (
    /\b(needs changes|request changes|changes requested|not approved)\b|需要修改|需修改|发现问题/.test(
      normalized,
    )
  ) {
    return "needs_changes";
  }
  if (/\b(approved|lgtm|no issues|passed)\b|通过|无问题/.test(normalized)) {
    return "passed";
  }
  return undefined;
}

function formatUsage(usage: any, dialogId: unknown) {
  const parts: string[] = [];
  if (typeof dialogId === "string" && dialogId)
    parts.push(`dialog=${dialogId}`);

  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const output = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  if (input || output) parts.push(`tokens=${input}+${output}`);

  return parts.length ? `  (${parts.join("  ")})` : "";
}

function buildTransportErrorHint(serverUrl: string, error: unknown) {
  const endpoint = `${serverUrl}/api/agent/run`;
  const reason = toErrorMessage(error);

  let detail = `[nolo] Could not reach ${endpoint}.\n` + `Reason: ${reason}\n`;

  try {
    const parsed = new URL(serverUrl);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      detail +=
        "If you meant local dev, start the local API first.\n" +
        "Otherwise set NOLO_SERVER to a reachable server, or re-run `nolo login --server https://nolo.chat`.\n";
      return detail;
    }
  } catch {
    // Keep the generic hint below when serverUrl is not a valid absolute URL.
  }

  detail +=
    "Check NOLO_SERVER / BASE_URL and make sure the configured server is reachable.\n";
  return detail;
}

async function readAgentRunFailureMetadata(
  res: Response,
): Promise<{ dialogId?: string }> {
  const data = await res
    .clone()
    .json()
    .catch(() => ({}));
  return {
    ...(asOptionalTrimmedString(data?.dialogId)
      ? { dialogId: asOptionalTrimmedString(data?.dialogId) }
      : {}),
  };
}

async function runHttpAgentTurn(
  options: RunAgentTurnOptions,
  authToken: string,
) {
  const spinner = new Spinner(
    options.output,
    `${options.agentName} -> working`,
  );
  spinner.start();

  const fetchImpl = options.fetchImpl ?? fetch;
  const subjectRefs = buildSubjectRefs(options);
  const allowedChildAgentKeys = options.allowedChildAgentKeys?.filter((key) =>
    key.trim(),
  );
  const allowedToolNames = options.allowedToolNames?.filter((name) =>
    name.trim(),
  );
  const shouldStream = !options.noStream && !options.background;
  const buildRequestBody = (stream: boolean) =>
    JSON.stringify({
      agentKey: options.agentKey,
      userInput: buildUserInputContent(options.message, options.imageUrls),
      runtimeContext: {
        surface: "cli",
        host: "terminal",
        runtime: "bun",
        entrypoint: "nolo-cli",
        capabilities: ["text-io", "streaming", "slash-commands"],
        ...(subjectRefs ? { subjectRefs } : {}),
        ...(allowedChildAgentKeys?.length ? { allowedChildAgentKeys } : {}),
        ...(allowedToolNames?.length ? { allowedToolNames } : {}),
      },
      ...(options.continueDialogId
        ? { continueDialogId: options.continueDialogId }
        : {}),
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.inheritedFromDialogKey
        ? { inheritedFromDialogKey: options.inheritedFromDialogKey }
        : {}),
      ...(options.parentDialogId
        ? { parentDialogId: options.parentDialogId }
        : {}),
      ...(options.background ? { background: true } : {}),
      ...(typeof options.timeoutMs === "number"
        ? { timeoutMs: options.timeoutMs }
        : {}),
      stream,
    });
  const postAgentRun = (stream: boolean) =>
    fetchImpl(`${options.serverUrl}/api/agent/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: buildRequestBody(stream),
    });
  let res: Response;
  try {
    res = await postAgentRun(shouldStream);
  } catch (error) {
    spinner.stop();
    options.output.write(buildTransportErrorHint(options.serverUrl, error));
    return { exitCode: 1 };
  }

  if (shouldStream && isGatewayHttpStatus(res.status)) {
    const failureMeta = await readAgentRunFailureMetadata(res);
    if (!failureMeta.dialogId) {
      spinner.stop();
      options.output.write(
        `[nolo] streaming request returned HTTP ${res.status}; retrying once without streaming.\n`,
      );
      spinner.start();
      try {
        res = await postAgentRun(false);
      } catch (error) {
        spinner.stop();
        options.output.write(buildTransportErrorHint(options.serverUrl, error));
        return { exitCode: 1 };
      }
    }
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") && res.body) {
    spinner.stop();
    const result = await readStreamingAgentRun(options, res);
    return result;
  }

  spinner.stop();
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    options.output.write(`[nolo] Agent request failed: HTTP ${res.status}\n`);
    const errorText = asTrimmedString(data?.error);
    const messageText = asTrimmedString(data?.message);
    const reasonText = asTrimmedString(data?.reason);
    const codeText = asTrimmedString(data?.code);
    const dialogIdText = asTrimmedString(data?.dialogId);
    if (errorText || messageText) {
      options.output.write(`${errorText || messageText}\n`);
      if (messageText && messageText !== errorText) {
        options.output.write(`${messageText}\n`);
      }
      if (codeText && codeText !== errorText && codeText !== messageText) {
        options.output.write(`code=${codeText}\n`);
      }
      if (
        reasonText &&
        reasonText !== errorText &&
        reasonText !== messageText
      ) {
        options.output.write(`reason=${reasonText}\n`);
      }
    }
    if (dialogIdText) {
      options.output.write(`[nolo] failed dialog: ${dialogIdText}\n`);
      options.output.write(
        `[nolo] continue with: nolo agent run ${options.agentKey} --continue ${dialogIdText} --msg "retry"\n`,
      );
    }
    return dialogIdText
      ? { exitCode: 1, dialogId: dialogIdText }
      : { exitCode: 1 };
  }

  const content = formatAssistantResponseForCli(
    String(data?.content ?? data?.message ?? ""),
    options,
  );
  if (content) {
    options.output.write(`\n${options.agentName} > ${content}\n`);
  } else {
    options.output.write(`\n${options.agentName} > (no text response)\n`);
  }

  const usage = formatUsage(data?.usage, data?.dialogId);
  if (usage && shouldShowUsage(options.env)) options.output.write(`${usage}\n`);
  return {
    exitCode: 0,
    ...(typeof data?.dialogId === "string" && data.dialogId
      ? { dialogId: data.dialogId }
      : {}),
    turnTokens: buildTurnTokenUsage(
      data?.usage,
      typeof data?.model === "string" ? data.model : options.agentKey,
    ),
  };
}

async function runInjectedLocalAgentTurn(options: RunAgentTurnOptions) {
  return runLocalAgentTurnForCli(options, { reportFailure: true });
}

async function refreshMissingLocalAgentConfig(options: RunAgentTurnOptions) {
  const adapter = resolveLocalRuntimeAdapter(options);
  if (!adapter) return false;
  const agentConfig = await adapter.loadAgentConfig(options.agentKey);
  return Boolean(agentConfig);
}

async function runLocalAgentTurnForCli(
  options: RunAgentTurnOptions,
  settings: { reportFailure: boolean },
) {
  const baseAdapter = resolveLocalRuntimeAdapter(options);
  if (!baseAdapter) {
    options.output.write(
      "[nolo] Local runtime was requested but no local runtime adapter is available.\n",
    );
    return { exitCode: 1 };
  }

  const subjectRefs = buildSubjectRefs(options);
  const allowedChildAgentKeys = options.allowedChildAgentKeys?.filter((key) =>
    key.trim(),
  );
  const allowedToolNames = options.allowedToolNames?.filter((name) =>
    name.trim(),
  );
  const runtimeContext: Record<string, any> | undefined =
    subjectRefs ||
    allowedChildAgentKeys?.length ||
    allowedToolNames?.length ||
    options.parentWakeOnTerminal
      ? {
          ...(subjectRefs ? { subjectRefs } : {}),
          ...(allowedChildAgentKeys?.length ? { allowedChildAgentKeys } : {}),
          ...(allowedToolNames?.length ? { allowedToolNames } : {}),
          ...(options.parentWakeOnTerminal
            ? { parentWakeOnTerminal: true }
            : {}),
          ...(options.parentDialogId
            ? { parentThreadId: options.parentDialogId }
            : {}),
        }
      : undefined;
  const currentDialogId = options.continueDialogId ?? ulid();

  const runChildTurn = async (
    input: LocalAgentTurnInput,
  ): Promise<LocalAgentTurnResult> => {
    const { runLocalAgentTurn } = await import("../agentRuntimeLocal");
    return runLocalAgentTurn(input);
  };

  const createFreshChildBaseAdapter = () =>
    options.localRuntimeAdapterFactory?.(options.env, {
      cwd: options.localRuntimeCwd,
    }) ?? buildDefaultLocalRuntimeAdapter(options);

  const withLocalDelegation = (args: {
    base: AgentRuntimeHostAdapter;
    dialogId: string;
    spaceId?: string;
    runtimeContext?: Record<string, any>;
  }): AgentRuntimeHostAdapter => {
    let adapter: AgentRuntimeHostAdapter;
    const callAgentExecutor = createCliCallAgentToolExecutor(
      {
        env: options.env,
        fetchImpl: options.fetchImpl,
        cwd: options.localRuntimeCwd,
        output: options.output,
      },
      {
        createChildAdapter: (child) =>
          withLocalDelegation({
            base: createFreshChildBaseAdapter(),
            dialogId: child.dialogId,
            spaceId: child.spaceId,
            runtimeContext: child.runtimeContext,
          }),
        runChildTurn,
        dialogId: args.dialogId,
        spaceId: args.spaceId,
        runtimeContext: args.runtimeContext,
      },
    );
    adapter = {
      ...args.base,
      executeTool: async (call) => {
        if (call.name === "callAgent") {
          return callAgentExecutor(call);
        }
        return args.base.executeTool(call);
      },
    };
    return adapter;
  };
  const adapter = withLocalDelegation({
    base: baseAdapter,
    dialogId: currentDialogId,
    spaceId: options.spaceId,
    runtimeContext,
  });

  const spinner = new Spinner(
    options.output,
    `${options.agentName} -> working locally`,
  );
  spinner.start();
  try {
    const toolDisplayMode = resolveToolDisplayMode(options.env);
    const traceLocalTools = shouldEmitToolEvents(toolDisplayMode);
    const formatToolEvent = createToolEventFormatter(toolDisplayMode);
    const eventMode = resolveAgentEventMode(options);
    let streamedAssistantText = false;
    let printedAssistantLabel = false;
    const thinkingMode = resolveThinkingDisplayMode(options.env);
    const renderMode = resolveRenderDisplayMode(options.env);
    const renderWriter = createRenderAwareStreamWriter({
      write: (chunk) => options.output.write(chunk),
      renderMode,
    });
    const thinkingFilter = createThinkingAwareStreamFilter(
      (chunk) => renderWriter.push(chunk),
      thinkingMode,
    );
    const runLocalAgentTurn = await loadRunLocalAgentTurn();
    const result = await runLocalAgentTurn({
      adapter,
      agentRef: options.agentKey,
      input: buildUserInputContent(options.message, options.imageUrls),
      continueDialogId: currentDialogId,
      spaceId: options.spaceId,
      category: options.category,
      inheritedFromDialogKey: options.inheritedFromDialogKey,
      parentDialogId: options.parentDialogId,
      background: options.background,
      noStream: options.noStream,
      ...(runtimeContext ? { runtimeContext } : {}),
      ...(typeof options.timeoutMs === "number"
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.actionGateHandler
        ? { onActionGate: options.actionGateHandler }
        : {}),
      ...(options.onLoopEvent ? { onLoopEvent: options.onLoopEvent } : {}),
      ...(traceLocalTools
        ? {
            onToolEvent: (event) => {
              spinner.stop();
              const chunk =
                eventMode === "jsonl"
                  ? formatToolJsonEvent(event)
                  : formatToolEvent(event);
              if (chunk) {
                options.output.write(chunk);
              }
            },
          }
        : {}),
      ...(!options.noStream
        ? {
            onTextDelta: (chunk) => {
              spinner.stop();
              if (!printedAssistantLabel) {
                options.output.write(`\n${options.agentName} > `);
                printedAssistantLabel = true;
              }
              streamedAssistantText = true;
              thinkingFilter.push(chunk);
            },
          }
        : {}),
    });
    spinner.stop();
    if (streamedAssistantText) {
      thinkingFilter.flush();
      renderWriter.flush();
      options.output.write("\n");
    } else {
      const content = formatAssistantResponseForCli(
        result.content.trim(),
        options,
      );
      if (content) {
        options.output.write(`\n${options.agentName} > ${content}\n`);
      } else {
        options.output.write(`\n${options.agentName} > (no text response)\n`);
      }
    }
    return {
      exitCode: 0,
      dialogId: result.dialogId,
      turnTokens: buildTurnTokenUsage(result.usage, result.model),
    };
  } catch (error) {
    spinner.stop();
    if (settings.reportFailure) {
      options.output.write(
        `[nolo] Local agent run failed: ${toErrorMessage(error)}\n`,
      );
    }
    return { exitCode: 1, localError: error };
  }
}

async function readStreamingAgentRun(
  options: RunAgentTurnOptions,
  res: Response,
): Promise<RunAgentTurnResult> {
  const reader = res.body?.getReader();
  if (!reader) {
    options.output.write(
      "[nolo] Agent stream response did not include a readable body.\n",
    );
    return { exitCode: 1 };
  }

  const decoder = new TextDecoder();
  const thinkingMode = resolveThinkingDisplayMode(options.env);
  const renderMode = resolveRenderDisplayMode(options.env);
  const renderWriter = createRenderAwareStreamWriter({
    write: (chunk) => options.output.write(chunk),
    renderMode,
  });
  const writer = createStreamingTextWriter({
    write: (chunk) => renderWriter.push(chunk),
  });
  const thinkingFilter = createThinkingAwareStreamFilter(
    (chunk) => writer.push(chunk),
    thinkingMode,
  );
  let buffer = "";
  let content = "";
  let dialogId: string | undefined;
  let usage: any;
  let hasPrintedLabel = false;

  const printLabel = () => {
    if (hasPrintedLabel) return;
    options.output.write(`\n${options.agentName} > `);
    hasPrintedLabel = true;
  };

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

    const chunk =
      payload?.type === "text"
        ? payload.content
        : typeof payload?.chunk === "string"
          ? payload.chunk
          : "";
    if (!chunk) return;

    printLabel();
    content += chunk;
    thinkingFilter.push(chunk);
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
  } finally {
    writer.flushAll();
    thinkingFilter.flush();
    renderWriter.flush();
  }

  if (!content) {
    options.output.write(`\n${options.agentName} > (no text response)\n`);
  } else {
    options.output.write("\n");
  }

  const usageText = formatUsage(usage, dialogId);
  if (usageText && shouldShowUsage(options.env))
    options.output.write(`${usageText}\n`);
  return {
    exitCode: 0,
    ...(dialogId ? { dialogId } : {}),
    turnTokens: buildTurnTokenUsage(usage, options.agentKey),
  };
}

export async function runAgentTurn(options: RunAgentTurnOptions) {
  const authToken = resolveAuthToken(options.env);
  const runtimeMode = resolveRequestedRuntimeMode(options);

  if (runtimeMode === "local") {
    return runInjectedLocalAgentTurn(options);
  }

  if (runtimeMode === "auto" && shouldAttemptAutoLocal(options)) {
    const skipLocal = await shouldSkipAutoLocalForServerPlatformTools(options);
    if (!skipLocal) {
      const localResult = await runLocalAgentTurnForCli(options, {
        reportFailure: false,
      });
      if (localResult.exitCode === 0) {
        return {
          exitCode: localResult.exitCode,
          ...(localResult.dialogId ? { dialogId: localResult.dialogId } : {}),
          ...(localResult.turnTokens
            ? { turnTokens: localResult.turnTokens }
            : {}),
        };
      }
      if (
        isMissingLocalAgentConfigError(localResult.localError, options.agentKey)
      ) {
        // Local config refresh is local-adapter only; still prefer local before any server path.
        options.output.write(
          `[nolo] Local agent config was missing; refreshing local config and retrying local once.\n`,
        );
        try {
          const refreshed = await refreshMissingLocalAgentConfig(options);
          if (refreshed) {
            const retriedLocalResult = await runLocalAgentTurnForCli(options, {
              reportFailure: false,
            });
            if (retriedLocalResult.exitCode === 0) {
              return {
                exitCode: retriedLocalResult.exitCode,
                ...(retriedLocalResult.dialogId
                  ? { dialogId: retriedLocalResult.dialogId }
                  : {}),
                ...(retriedLocalResult.turnTokens
                  ? { turnTokens: retriedLocalResult.turnTokens }
                  : {}),
              };
            }
          }
        } catch {
          // Fall through — server fallback only when authenticated (M3).
        }
      }
      // M3: no server fallback without an auth token. Surface local failure instead.
      if (!authToken) {
        const localErrorMessage = localResult.localError
          ? toErrorMessage(localResult.localError)
          : "local runtime failed";
        options.output.write(
          `[nolo] auto runtime: local run unavailable (${localErrorMessage}). ` +
            "No auth token is set, so server fallback is disabled. " +
            "Fix local credentials/config, or run `nolo login` / set AUTH_TOKEN to enable server runtime.\n",
        );
        return {
          exitCode: 1,
          ...(localResult.dialogId ? { dialogId: localResult.dialogId } : {}),
        };
      }
      if (localResult.localError) {
        options.output.write(
          `[nolo] auto runtime: local run unavailable (${toErrorMessage(localResult.localError)}); falling back to server.\n`,
        );
      }
    }
  }

  if (!authToken) {
    options.output.write(
      "[nolo] This install needs an auth token before it can talk to agents.\n" +
        "Run `nolo login`, or set AUTH_TOKEN / NOLO_SERVER for non-interactive runs.\n",
    );
    return { exitCode: 1 };
  }

  return runHttpAgentTurn(options, authToken);
}
