import type { MachineHeartbeat } from "../connector-experimental/protocol";
import type { CliFetchImpl } from "./cliFetch";
import { resolveConnectorWebSocketTarget } from "./connectorWebSocketTarget";
import { resolveCliAgentKeyInput } from "./agentAliases";
import {
  type AgentCommandDeps,
  getReadableCliDb,
  type LocalCliExecutor,
  type SmokeWebSocketOptions,
} from "./agentCommandSupport";
import {
  readAgentRecord,
  resolveAgentRecordFromHybridStore,
  writeAgentRecord,
} from "./agentRecordHelpers";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerUrl,
  type EnvLike,
} from "./cliEnvHelpers";

async function defaultExecuteCli(
  provider: string,
  prompt: string,
  options: { model?: string; timeout?: number; cwd?: string; yolo?: boolean }
) {
  const { executeCli } = await import("../ai/agent/cliExecutor");
  return executeCli(provider as any, prompt, options);
}

async function forwardConnectorRunMessage(
  machine: MachineHeartbeat,
  message: string,
  pushMessage: (response: string) => void,
  executeCli: LocalCliExecutor,
  env: EnvLike,
  fetchImpl: CliFetchImpl
) {
  const { handleConnectorRunMessage } = await import("./machineWsRunDispatch");
  return handleConnectorRunMessage(message, pushMessage, executeCli, env, fetchImpl);
}

async function detectLaunchableMachineInfo() {
  const { detectMachineInfo } = await import("../connector-experimental/machineInfo");
  return detectMachineInfo({ probeLaunchable: true });
}

function requiredCapabilityForAgent(agent: any) {
  if (agent?.apiSource !== "cli") return "";
  const cliProvider = String(agent?.cliProvider || agent?.provider || "").trim().toLowerCase();
  const capabilityByProvider: Record<string, string> = {
    codex: "codex-cli",
    claude: "claude-code",
    copilot: "copilot-cli",
    gemini: "gemini-cli",
    kimi: "kimi-cli",
    agy: "agy-cli",
    qoder: "qoder-cli",
    opencode: "opencode-cli",
    grok: "grok-cli",
  };
  return capabilityByProvider[cliProvider] ?? "";
}

function resolveAgentCliProvider(agent: any) {
  return String(agent?.cliProvider || agent?.provider || "").trim().toLowerCase();
}

function classifyAgentRuntime(agent: any) {
  if (agent?.apiSource === "cli") return "cli-machine";
  if (agent?.apiSource === "platform" || agent?.useServerProxy) return "platform-local-loop";
  if (agent?.apiSource === "local") return "local-provider-loop";
  return "unknown";
}

function shouldRuntimeDoctorPass(args: {
  runtimeClass: string;
  requiredCapability: string;
  hasCapability: boolean;
}) {
  if (args.runtimeClass !== "cli-machine") return args.runtimeClass !== "unknown";
  return Boolean(args.requiredCapability && args.hasCapability);
}

function assertSmokeCompatible(agent: any, machine: MachineHeartbeat) {
  if (agent?.apiSource !== "cli") {
    throw new Error(`Agent ${agent?.name ?? agent?.dbKey ?? "unknown"} is not a CLI agent.`);
  }
  const requiredCapability = requiredCapabilityForAgent(agent);
  if (!requiredCapability) {
    throw new Error(`Agent ${agent?.name ?? agent?.dbKey ?? "unknown"} has unsupported cliProvider: ${agent?.cliProvider ?? "missing"}.`);
  }
  if (!machine.capabilities.includes(requiredCapability)) {
    const currentCapabilities = machine.capabilities.length
      ? machine.capabilities.join(", ")
      : "none";
    throw new Error(
      `Agent ${agent?.name ?? agent?.dbKey ?? "unknown"} requires ${requiredCapability}; current machine capabilities: ${currentCapabilities}.`
    );
  }
}

const CONNECTOR_WS_KEEPALIVE_MS = 25_000;

function buildConnectorKeepaliveMessage() {
  return JSON.stringify({ type: "connector.keepalive", sentAt: Date.now() });
}

async function defaultConnectWebSocket(url: string, options: SmokeWebSocketOptions) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime");
  }
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocketCtor(url, { headers: options.headers } as any);
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const clearKeepalive = () => {
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
    };
    ws.addEventListener("open", () => {
      keepalive = setInterval(() => {
        try {
          ws.send(buildConnectorKeepaliveMessage());
        } catch {
          clearKeepalive();
        }
      }, CONNECTOR_WS_KEEPALIVE_MS);
      Promise.resolve(options.onOpen())
        .then(() => ws.close())
        .catch((error) => {
          ws.close();
          reject(error);
        });
    }, { once: true });
    ws.addEventListener("error", () => {
      clearKeepalive();
      reject(new Error("connector websocket failed"));
    });
    ws.addEventListener("close", () => {
      clearKeepalive();
      resolve();
    }, { once: true });
    ws.addEventListener("message", (event) => {
      const startIndex = options.sentMessages.length;
      Promise.resolve(options.onMessage(String(event.data))).then(() => {
        for (const message of options.sentMessages.slice(startIndex)) {
          ws.send(message);
        }
      }).catch(reject);
    });
  });
}

async function heartbeatCurrentMachine(args: {
  authToken: string;
  fetchImpl: CliFetchImpl;
  machine: MachineHeartbeat;
  serverUrl: string;
}) {
  const res = await args.fetchImpl(`${args.serverUrl}/api/machines/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.machine),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`heartbeat failed: HTTP ${res.status} ${text}`);
  }
}

export async function runAgentBindCurrentCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const agentInput = args[0]?.trim();
  if (!agentInput || agentInput === "--help" || agentInput === "-h") {
    output.write("Usage: nolo agent bind-current <agentKey|handle>\n");
    return agentInput ? 0 : 1;
  }

  const authToken = resolveAuthToken(env);
  if (!authToken) {
    output.write("[nolo] agent bind-current requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] agent bind-current could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const serverUrl = resolveServerUrl(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const machine = await (deps.machineInfo ?? detectLaunchableMachineInfo)();
  let boundAgentKey = "";

  try {
    await heartbeatCurrentMachine({ authToken, fetchImpl, machine, serverUrl });
    const db = deps.db ?? await getReadableCliDb(output);
    const resolved = await resolveAgentRecordFromHybridStore({
      agentInput,
      env,
      db,
      fetchImpl,
      fallbackFetchImpl,
    });
    if (!resolved) {
      throw new Error(`agent not found: ${resolveCliAgentKeyInput(agentInput)}`);
    }
    const agentKey = resolved.agentKey;
    boundAgentKey = agentKey;
    const existing = resolved.record;
    const updated = {
      ...existing,
      runtimeBinding: {
        ...(existing?.runtimeBinding && typeof existing.runtimeBinding === "object"
          ? existing.runtimeBinding
          : {}),
        machineId: machine.machineId,
        ownerUserId: userId,
      },
      updatedAt: Date.now(),
    };
    await writeAgentRecord({
      agentKey,
      authToken,
      fallbackFetchImpl,
      fetchImpl,
      serverUrl,
      userId,
      record: updated,
    });
  } catch (error) {
    output.write(
      `[nolo] agent bind-current failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }

  output.write(`Bound agent ${boundAgentKey} to this machine: ${machine.name} (${machine.machineId})\n`);
  return 0;
}

export async function runAgentSmokeCurrentCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const agentInput = args[0]?.trim();
  if (!agentInput || agentInput === "--help" || agentInput === "-h") {
    output.write("Usage: nolo agent smoke-current <agent> --msg \"hello\"\n");
    return agentInput ? 0 : 1;
  }
  const agentKey = resolveCliAgentKeyInput(agentInput);

  const authToken = resolveAuthToken(env);
  if (!authToken) {
    output.write("[nolo] agent smoke-current requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }
  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] agent smoke-current could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const userInput = readOption(args, "--msg") ?? "Smoke test from nolo connector.";
  const serverUrl = resolveServerUrl(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const machine = await (deps.machineInfo ?? detectLaunchableMachineInfo)();
  const sentMessages: string[] = [];

  try {
    await heartbeatCurrentMachine({ authToken, fetchImpl, machine, serverUrl });
    const existing = await readAgentRecord({ agentKey, authToken, fallbackFetchImpl, fetchImpl, serverUrl });
    assertSmokeCompatible(existing, machine);
    await writeAgentRecord({
      agentKey,
      authToken,
      fallbackFetchImpl,
      fetchImpl,
      serverUrl,
      userId,
      record: {
        ...existing,
        runtimeBinding: {
          ...(existing?.runtimeBinding && typeof existing.runtimeBinding === "object"
            ? existing.runtimeBinding
            : {}),
          machineId: machine.machineId,
          ownerUserId: userId,
        },
        updatedAt: Date.now(),
      },
    });

    let runResponse: any = null;
    const wsTarget = await resolveConnectorWebSocketTarget({
      serverUrl,
      machineId: machine.machineId,
      headers: { Authorization: `Bearer ${authToken}` },
      fetchImpl,
    });
    await (deps.connectWebSocket ?? defaultConnectWebSocket)(
      wsTarget,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        sentMessages,
        onMessage: (message) => (deps.connectorRunMessageHandler ?? forwardConnectorRunMessage)(
          machine,
          message,
          (response) => sentMessages.push(response),
          deps.executeCli ?? defaultExecuteCli,
          {
            ...env,
            NOLO_SERVER: serverUrl,
            NOLO_SERVER_URL: serverUrl,
            BASE_URL: serverUrl,
            AUTH_TOKEN: authToken,
            NOLO_MACHINE_API_KEY: authToken,
          },
          fetchImpl
        ),
        onOpen: async () => {
          const res = await fetchImpl(`${serverUrl}/api/agent/run`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              agentKey,
              userInput,
              stream: false,
            }),
          });
          runResponse = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(`agent run failed: HTTP ${res.status} ${JSON.stringify(runResponse)}`);
          }
        },
      }
    );
    output.write(`Smoke OK: ${runResponse?.dialogId ?? "no-dialog"}\n`);
    if (runResponse?.content) output.write(`${runResponse.content}\n`);
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent smoke-current failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }
}

export async function runAgentRuntimeDoctorCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const agentInput = args[0]?.trim();
  if (!agentInput || agentInput === "--help" || agentInput === "-h") {
    output.write("Usage: nolo agent runtime-doctor <agentKey>\n");
    return agentInput ? 0 : 1;
  }
  const authToken = resolveAuthToken(env);
  if (!authToken) {
    output.write("[nolo] agent runtime-doctor requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const serverUrl = resolveServerUrl(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const machine = await (deps.machineInfo ?? detectLaunchableMachineInfo)();

  try {
    const db = deps.db ?? await getReadableCliDb(output);
    const resolved = await resolveAgentRecordFromHybridStore({
      agentInput,
      env,
      db,
      fetchImpl,
      fallbackFetchImpl,
    });
    if (!resolved) {
      throw new Error(`agent not found: ${resolveCliAgentKeyInput(agentInput)}`);
    }
    const agentKey = resolved.agentKey;
    const agent = resolved.record;
    const requiredCapability = requiredCapabilityForAgent(agent);
    const runtimeClass = classifyAgentRuntime(agent);
    const isBoundToCurrent = agent?.runtimeBinding?.machineId === machine.machineId;
    const hasCapability = requiredCapability
      ? machine.capabilities.includes(requiredCapability)
      : false;
    output.write(`Agent runtime doctor: ${agent?.name ?? agentKey}\n`);
    if (agentInput !== agentKey) output.write(`Agent input: ${agentInput}\n`);
    output.write(`Agent key: ${agentKey}\n`);
    output.write(`Runtime class: ${runtimeClass}\n`);
    output.write(`API source: ${agent?.apiSource ?? "unknown"}\n`);
    output.write(`CLI provider: ${resolveAgentCliProvider(agent) || "none"}\n`);
    output.write(`Required capability: ${requiredCapability || "none"}\n`);
    output.write(`Current machine: ${machine.name} (${machine.machineId})\n`);
    output.write(`Current machine capabilities: ${machine.capabilities.length ? machine.capabilities.join(", ") : "none"}\n`);
    output.write(`Current machine binding: ${runtimeClass === "cli-machine" ? (isBoundToCurrent ? "yes" : "no") : "not required"}\n`);
    output.write(`Current machine has required capability: ${requiredCapability ? (hasCapability ? "yes" : "no") : "not required"}\n`);

    return shouldRuntimeDoctorPass({ runtimeClass, requiredCapability, hasCapability }) ? 0 : 1;
  } catch (error) {
    output.write(
      `[nolo] agent runtime-doctor failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }
}
