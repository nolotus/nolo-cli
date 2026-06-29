import type { MachineHeartbeat } from "./connector-experimental/protocol";
import type { CliKvDb } from "./client/hybridRecordStore";
import type { EnvLike } from "./cliEnvHelpers";

export type OutputLike = { write(chunk: string): unknown };

export type SmokeWebSocketOptions = {
  headers: Record<string, string>;
  onMessage: (message: string) => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  sentMessages: string[];
};

export type LocalCliExecutor = (
  provider: string,
  prompt: string,
  options: {
    model?: string;
    timeout?: number;
    cwd?: string;
    yolo?: boolean;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  }
) => Promise<{ text: string; raw?: string; elapsed?: number }>;

export type LocalRuntimeProbeResult = {
  ok: boolean;
  dbPath: string;
  authorityDriver?: string;
  authorityEndpoint?: string;
  authorityMetadataPath?: string;
  authorityHealthPath?: string;
  agentFound: boolean;
  agentKey?: string;
  error?: string;
};

export type AgentCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  db?: CliKvDb;
  fetchImpl?: typeof fetch;
  fallbackFetchImpl?: typeof fetch;
  machineInfo?: () => MachineHeartbeat;
  connectWebSocket?: (url: string, options: SmokeWebSocketOptions) => Promise<void>;
  executeCli?: LocalCliExecutor;
  connectorRunMessageHandler?: (
    machine: MachineHeartbeat,
    message: string,
    pushMessage: (response: string) => void,
    executeCli: LocalCliExecutor,
    env: EnvLike,
    fetchImpl: typeof fetch
  ) => Promise<void>;
  localRuntimeProbe?: (env: EnvLike) => Promise<LocalRuntimeProbeResult>;
};

async function getDefaultCliDb() {
  const { getDefaultCliLocalRuntimeDb } = await import("./localRuntimeDb");
  return getDefaultCliLocalRuntimeDb();
}

function createNullCliDb(): CliKvDb {
  return {
    get: async () => {
      throw new Error("local cache unavailable");
    },
    put: async () => undefined,
    del: async () => undefined,
    batch: async () => undefined,
    iterator: () => {
      throw new Error("local cache unavailable");
    },
  };
}

export async function getReadableCliDb(output: OutputLike) {
  try {
    return await getDefaultCliDb();
  } catch (error) {
    output.write(
      `[nolo] local agent cache unavailable; falling back to remote reads only: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return createNullCliDb();
  }
}
