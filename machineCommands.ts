import type { MachineHeartbeat } from "./connector-experimental/protocol";
import { detectMachineInfo } from "./connector-experimental/machineInfo";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import {
  type HeartbeatLoopOptions,
  runHeartbeatLoop as defaultRunHeartbeatLoop,
} from "./connector-experimental/heartbeatLoop";
import {
  buildMachinePermissionPromptBlock,
  resolveMachineRunPermissionPolicy,
} from "./ai/agent/machineRunPermissions";
import { resolveConnectorWebSocketTarget } from "./connectorWebSocketTarget";
import {
  checkConnectorWorkspaceLinks,
  runMachineDaemonCommand,
} from "./machineDaemonCommands";
import { runMachineHeartbeatConnectCommand } from "./machineHeartbeatCommands";
import { runMachineWatchCommand } from "./machineWatchCommands";
import {
  handleConnectorRunMessage,
  type LocalCliExecutor,
} from "./machineWsRunDispatch";
import {
  defaultConnectWebSocket,
  runMachineWsSession,
  type ConnectorWebSocketOptions,
} from "./machineWsSession";
export {
  formatMachineStatus,
  runMachineStatusCommand,
  type MachineSummary,
} from "./machineStatusCommands";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

type MachineCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  signal?: AbortSignal;
  cliEntrypointPath?: string;
  maxConnectorAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  machineInfo?: () => MachineHeartbeat;
  runHeartbeatLoop?: (options: HeartbeatLoopOptions) => Promise<void>;
  connectWebSocket?: (url: string, options: ConnectorWebSocketOptions) => Promise<void>;
  executeCli?: LocalCliExecutor;
  validateWorkspaceLinks?: (cwd: string) => string[] | Promise<string[]>;
  spawnDaemon?: (args: {
    cmd: string[];
    cwd: string;
    env: EnvLike;
    logPath: string;
  }) => { pid?: number };
};

function resolveServerUrl(env: EnvLike) {
  return (env.NOLO_SERVER || env.BASE_URL || DEFAULT_NOLO_SERVER_URL).replace(/\/+$/, "");
}

function resolveAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || "";
}

function writeAuthMissing(output: OutputLike) {
  output.write(
    "[nolo] Machine commands require an auth token. Run `nolo login` or set AUTH_TOKEN.\n"
  );
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function readOption(args: string[], flag: string) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const next = args[i + 1];
      if (typeof next === "string" && !next.startsWith("-")) return next;
      return "";
    }
    if (arg.startsWith(flag + "=")) {
      return arg.slice(flag.length + 1);
    }
  }
  return "";
}

function resolveConnectServerUrl(args: string[], env: EnvLike) {
  const fromFlag = readOption(args, "--server-url") || readOption(args, "--server");
  const raw = fromFlag || env.NOLO_SERVER || env.BASE_URL || DEFAULT_NOLO_SERVER_URL;
  return String(raw).replace(/\/+$|\s+$/g, "").replace(/\/+$/g, "").replace(/\s+$/g, "");
}

function resolveConnectAuthToken(args: string[], env: EnvLike) {
  return readOption(args, "--machine-key") || readOption(args, "--token") || resolveAuthToken(env);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sleepWithAbort(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal) {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) return;
  await Promise.race([
    sleep(ms),
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}

function resolveConnectorReconnectDelayMs(env: EnvLike) {
  const raw = Number(env.NOLO_CONNECT_RECONNECT_MS ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

async function defaultExecuteCli(
  provider: string,
  prompt: string,
  options: {
    model?: string;
    timeout?: number;
    cwd?: string;
    yolo?: boolean;
    env?: EnvLike;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  }
) {
  const { executeCli } = await import("./ai/agent/cliExecutor");
  return executeCli(provider as any, prompt, options);
}

function detectLaunchableMachineInfo() {
  return detectMachineInfo({ probeLaunchable: true });
}

function findTaskRowSubjectRef(runtimeContext: any) {
  const subjectRefs = Array.isArray(runtimeContext?.subjectRefs) ? runtimeContext.subjectRefs : [];
  for (const ref of subjectRefs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
    if (ref.kind !== "table-row") continue;
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (id) return id;
  }
  return "";
}

function buildTaskEvidencePrompt(args: {
  agentKey: string;
  agentConfig: any;
  runtimeContext: any;
}) {
  const rowDbKey = findTaskRowSubjectRef(args.runtimeContext);
  if (!rowDbKey) return "";
  return [
    "--- Nolo task evidence context ---",
    "This CLI runtime does not receive server-side function tools directly.",
    "Use the task row subjectRef and linked dialog evidence as durable task evidence.",
    "Run commands from the repository root. The runner already provides server URL and auth in the environment.",
    "Release boundary: after review passes, AI/reviewer/Codex may advance alpha for verification. Do not merge, push, or release main/release unless the human owner explicitly authorizes it in the current request.",
    "Handoff context: query dialog.subjectRefs first, then inspect dialog checkpoints, artifacts, commits, and test evidence. Treat row activityRefs/latestActivityRef as cache hints, not state truth.",
    "Reviewer autonomy: if you are reviewing and find a concrete fix, you may directly dispatch the rework agent/dialog instead of sending the task back to PM first.",
    "Rework evidence rule: every implementation, review, and rework dialog must preserve the same table-row subjectRef and report any child/rework dialog id it starts.",
    `Read task row: bun packages/cli/index.ts table query --table meta-0e95801d90-01KWSK4Q4TESXQ06SW39JN2TTJ --row ${JSON.stringify(rowDbKey)} --include-activity --output json`,
    `Query linked dialogs: bun packages/cli/index.ts dialog query --row-dbkey ${JSON.stringify(rowDbKey)} --json`,
    "If this run already has a dialog id, exclude it from evidence queries: bun packages/cli/index.ts dialog query --row-dbkey <rowDbKey> --exclude-dialog <currentDialogId> --json",
    "Then read exact dialog traces with: bun packages/cli/index.ts dialog read <dialogId>",
    "Reviewers must end with exactly one line: Review decision: approved | needs_changes | blocked",
    "Report progress, blockers, worktree, branch, commit/diff, tests, and unverified items in the dialog.",
  ].join("\n");
}

function buildConnectorCliPrompt(agentConfig: any, userInput: string, bridgeArgs?: {
  agentKey: string;
  runtimeContext: any;
}, permissionPolicy?: ReturnType<typeof resolveMachineRunPermissionPolicy>) {
  const policy = permissionPolicy ?? resolveMachineRunPermissionPolicy(agentConfig);
  return [
    typeof agentConfig?.prompt === "string" ? agentConfig.prompt.trim() : "",
    bridgeArgs ? buildTaskEvidencePrompt({
      agentKey: bridgeArgs.agentKey,
      agentConfig,
      runtimeContext: bridgeArgs.runtimeContext,
    }) : "",
    buildMachinePermissionPromptBlock(policy),
    `--- User task ---\n${userInput}`,
  ].filter(Boolean).join("\n\n");
}

export async function runMachineConnectCommand(
  args: string[],
  deps: MachineCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const authToken = resolveConnectAuthToken(args, env);
  if (!authToken) {
    writeAuthMissing(output);
    return 1;
  }

  const serverUrl = resolveConnectServerUrl(args, env);
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (hasFlag(args, "--daemon") || hasFlag(args, "--background")) {
    return runMachineDaemonCommand({
      env,
      output,
      cliEntrypointPath: deps.cliEntrypointPath,
      validateWorkspaceLinks: deps.validateWorkspaceLinks,
      spawnDaemon: deps.spawnDaemon,
    });
  }

  const machine = (deps.machineInfo ?? detectLaunchableMachineInfo)();
  const sendHeartbeat = async () => {
    const res = await fetchImpl(`${serverUrl}/api/machines/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(machine),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}\n${text}`);
    }
  };

  if (hasFlag(args, "--ws")) {
    const validateWorkspaceLinks = deps.validateWorkspaceLinks ?? (() => []);
    if (!(await checkConnectorWorkspaceLinks(process.cwd(), output, validateWorkspaceLinks))) {
      return 1;
    }
    const maxAttempts = deps.maxConnectorAttempts ?? Infinity;
    const sleep = deps.sleep ?? defaultSleep;
    const reconnectDelayMs = resolveConnectorReconnectDelayMs(env);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (deps.signal?.aborted) {
        return 0;
      }
      const runtimeServerUrl =
        env.NOLO_CONNECT_RUNTIME_SERVER_URL ||
        env.NOLO_RUNTIME_SERVER_URL ||
        serverUrl;
      const sessionResult = await runMachineWsSession({
        env,
        output,
        signal: deps.signal,
        machine,
        sendHeartbeat,
        runHeartbeatLoop: deps.runHeartbeatLoop ?? defaultRunHeartbeatLoop,
        connectWebSocket: deps.connectWebSocket ?? defaultConnectWebSocket,
        serverUrl,
        authToken,
        resolveConnectorWebSocketTarget: (options) =>
          resolveConnectorWebSocketTarget({
            ...options,
            fetchImpl,
          }),
        onMessage: (message, send) =>
          handleConnectorRunMessage(
            message,
            send,
            deps.executeCli ?? defaultExecuteCli,
            {
              ...env,
              NOLO_SERVER: runtimeServerUrl,
              NOLO_SERVER_URL: runtimeServerUrl,
              BASE_URL: runtimeServerUrl,
              AUTH_TOKEN: authToken,
              NOLO_MACHINE_API_KEY: authToken,
            },
            fetchImpl,
            {
              buildConnectorCliPrompt,
            }
          ),
      });
      const exitCode = sessionResult.exitCode;
      if (exitCode === 2) return 1;
      if (deps.signal?.aborted) {
        return 0;
      }
      if (attempt >= maxAttempts) return exitCode;
      const retryDelayMs = sessionResult.retryAfterMs ?? reconnectDelayMs;
      const reconnectContext =
        sessionResult.reconnectReason === "core_draining" ? " during core draining" : "";
      output.write(
        `[nolo] Connector websocket disconnected${reconnectContext}. Reconnecting in ${retryDelayMs}ms.\n`
      );
      await sleepWithAbort(retryDelayMs, sleep, deps.signal);
    }
    return 0;
  }

  if (hasFlag(args, "--watch")) {
    return runMachineWatchCommand({
      env,
      output,
      machine,
      sendHeartbeat,
      runHeartbeatLoop: deps.runHeartbeatLoop ?? defaultRunHeartbeatLoop,
    });
  }

  return runMachineHeartbeatConnectCommand({
    output,
    machine,
    sendHeartbeat,
  });
}

