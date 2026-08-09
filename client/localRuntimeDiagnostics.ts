import type { AgentRuntimeAgentConfig } from "../agentRuntimeLocal";
import type { HybridRecordStore } from "./hybridRecordStore";
import { getDefaultCliLocalRuntimeDb, type CliLocalRuntimeDb } from "../localRuntimeDb";
import { ulid } from "ulid";
import type { EnvLike } from "./localRuntimeHelpers";
import type { CliFetchImpl } from "../cliFetch";
import type { ReadToolFn } from "./cliLocalToolExecutors";
import type { LocalCliExecutor } from "./localRuntimeAdapterTypes";
import type { FetchInput, FetchInit } from "./localRuntimeFetchRetry";
import type { buildOpenAiTools } from "./localRuntimeTools";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import type {
  UserChoiceRequest,
  UserChoiceResult,
} from "./localRuntimeAdapterTypes";
import type { CollapsedPasteStore } from "../core/collapsedPaste";

export type CliLocalRuntimeAdapterDeps = {
  env: EnvLike;
  db?: CliLocalRuntimeDb;
  store?: HybridRecordStore;
  now?: () => number;
  createId?: () => string;
  fetchImpl?: CliFetchImpl;
  cwd?: string;
  output?: { write(chunk: string): unknown };
  localToolExecutors?: Record<
    string,
    (
      call: any,
    ) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  >;
  readXPost?: ReadToolFn;
  readXhsProfile?: ReadToolFn;
  executeCli?: LocalCliExecutor;
  sleep?: (ms: number) => Promise<void>;
  loopbackRequest?: (input: FetchInput, init?: FetchInit) => Promise<Response>;
  /** 重试进度上报（TUI 活动行显示「自动重试 N/M」）。透传给 fetchWithTransientRetry.onRetry。 */
  activityReporter?: (label: string | null) => void;
  buildProviderOpenAiTools?: typeof buildOpenAiTools;
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
  pastedTextStore?: CollapsedPasteStore;
};

export type PreparedAgentRuntime = {
  agentConfig: AgentRuntimeAgentConfig;
  activeAgentToolNames: string[];
  runtimeToolExecutionLimits: Record<string, unknown>;
  localToolExecutors: Record<
    string,
    (
      call: any,
    ) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  >;
};

export const preparedAgentRuntimeCache = new Map<string, PreparedAgentRuntime>();
export const hybridStoreCache = new Map<string, Promise<HybridRecordStore>>();

export function normalizeRuntimeCacheCwd(cwd?: string) {
  return (cwd?.trim() || process.cwd()).replace(/\/+$/, "") || ".";
}

export function buildPreparedAgentCacheKey(args: {
  userId: string;
  agentRef: string;
  cwd: string;
  systemBuiltinSkills?: Record<string, boolean> | null;
}) {
  const systemBuiltinSkillsKey = args.systemBuiltinSkills
    ? JSON.stringify(
        Object.keys(args.systemBuiltinSkills)
          .sort()
          .map((key) => [key, args.systemBuiltinSkills?.[key]]),
      )
    : "default";
  return `${args.userId}\0${args.agentRef}\0${args.cwd}\0${systemBuiltinSkillsKey}`;
}

export function clearCliLocalRuntimePreparedAgentCache() {
  preparedAgentRuntimeCache.clear();
  hybridStoreCache.clear();
}

export async function defaultLocalRuntimeDb(): Promise<CliLocalRuntimeDb> {
  return getDefaultCliLocalRuntimeDb();
}

export function createFallbackId() {
  return ulid();
}

export function logLocalRuntimeDiagnostic(
  event: string,
  fields: Record<string, unknown>,
) {
  if (
    process.env.NOLO_LOCAL_RUNTIME_DEBUG !== "1" &&
    process.env.NOLO_DEBUG !== "1"
  ) {
    return;
  }
  console.error(`[nolo-local-runtime] ${event} ${JSON.stringify(fields)}`);
}

export function summarizeOpenAiToolNames(tools: Array<Record<string, unknown>>) {
  return tools.reduce<string[]>((acc, tool) => {
    const fn = tool.function;
    const name =
      fn &&
      typeof fn === "object" &&
      "name" in fn &&
      typeof fn.name === "string"
        ? fn.name
        : null;
    if (name) acc.push(name);
    return acc;
  }, []);
}
