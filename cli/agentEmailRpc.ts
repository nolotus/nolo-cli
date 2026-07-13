import { createAgentKey } from "../database/keys";
import { resolveCliAgentKeyInput } from "./agentAliases";
import type { CliKvDb } from "./client/hybridRecordStore";
import {
  fetchWithTransportFallback,
  resolveAgentRecordFromHybridStore,
} from "./agentRecordHelpers";
import type { EnvLike } from "./cliEnvHelpers";
import { parseUserIdFromAuthToken, resolveServerUrl } from "./cliEnvHelpers";
import type { CliFetchImpl } from "./cliFetch";

export type AgentEmailRpcMethod =
  | "bindAgentEmailIdentity"
  | "provisionAgentEmailIdentity";

export type AgentEmailIdentityRpcData = {
  agentId: string;
  emailAddress: string;
  readinessStatus: string | null;
  ingressReadyAt: string | null;
  lastWarmupAt: string | null;
  lastWarmupError: string | null;
  localPart?: string;
  domain?: string;
  provider?: string;
  purpose?: string | null;
  delegationResourcePrefix?: string;
};


function readRpcErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "message" in body) {
    const message = body.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return `RPC failed (${status})`;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(
  body: Record<string, unknown>,
  key: string
): string | null {
  const value = body[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAgentEmailIdentityRpcData(body: unknown): AgentEmailIdentityRpcData {
  if (!isRecord(body)) {
    throw new Error("RPC response was not a JSON object");
  }
  const agentId = body.agentId;
  const emailAddress = body.emailAddress;
  if (typeof agentId !== "string" || !agentId.trim()) {
    throw new Error("RPC response missing agentId");
  }
  if (typeof emailAddress !== "string" || !emailAddress.trim()) {
    throw new Error("RPC response missing emailAddress");
  }

  const parsed: AgentEmailIdentityRpcData = {
    agentId,
    emailAddress,
    readinessStatus: readNullableString(body, "readinessStatus"),
    ingressReadyAt: readNullableString(body, "ingressReadyAt"),
    lastWarmupAt: readNullableString(body, "lastWarmupAt"),
    lastWarmupError: readNullableString(body, "lastWarmupError"),
  };

  const localPart = readOptionalString(body, "localPart");
  const domain = readOptionalString(body, "domain");
  const provider = readOptionalString(body, "provider");
  const delegationResourcePrefix = readOptionalString(
    body,
    "delegationResourcePrefix"
  );
  if (localPart) parsed.localPart = localPart;
  if (domain) parsed.domain = domain;
  if (provider) parsed.provider = provider;
  if ("purpose" in body) {
    const purpose = body.purpose;
    parsed.purpose =
      purpose === null || purpose === undefined
        ? null
        : typeof purpose === "string"
          ? purpose
          : null;
  }
  if (delegationResourcePrefix) {
    parsed.delegationResourcePrefix = delegationResourcePrefix;
  }

  return parsed;
}

function readAgentRecordFromRpcBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !("agent" in body)) {
    throw new Error("RPC response missing agent record");
  }
  const agent = body.agent;
  if (!isRecord(agent)) {
    throw new Error("RPC response agent field is invalid");
  }
  return agent;
}

export async function resolveAgentIdForEmailRpc(args: {
  agentInput: string;
  cliArgs?: string[];
  env: EnvLike;
  db: CliKvDb;
  authToken: string;
  fetchImpl: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
}): Promise<string> {
  const resolvedInput = resolveCliAgentKeyInput(args.agentInput);
  if (resolvedInput.startsWith("agent-")) {
    return resolvedInput;
  }

  const userId = parseUserIdFromAuthToken(args.authToken);
  if (!userId) {
    throw new Error("Could not read userId from auth token");
  }

  const resolved = await resolveAgentRecordFromHybridStore({
    agentInput: args.agentInput,
    cliArgs: args.cliArgs,
    env: args.env,
    db: args.db,
    fetchImpl: args.fetchImpl,
    fallbackFetchImpl: args.fallbackFetchImpl,
  });
  if (resolved?.agentKey) {
    return resolved.agentKey;
  }

  return createAgentKey.private(userId, resolvedInput);
}

export async function postAgentEmailRpc(args: {
  method: AgentEmailRpcMethod;
  body: Record<string, unknown>;
  cliArgs?: string[];
  env: EnvLike;
  authToken: string;
  fetchImpl: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
}): Promise<{
  data: AgentEmailIdentityRpcData;
  agent: Record<string, unknown>;
  baseUrl: string;
}> {
  const baseUrl = args.cliArgs
    ? resolveServerUrl(args.cliArgs, args.env)
    : resolveServerUrl(args.env);
  const url = `${baseUrl}/rpc/${args.method}`;
  const response = await fetchWithTransportFallback(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.body),
    },
    {
      fetchImpl: args.fetchImpl,
      fallbackFetchImpl: args.fallbackFetchImpl,
    }
  );

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readRpcErrorMessage(raw, response.status));
  }

  const data = parseAgentEmailIdentityRpcData(raw);
  const agent = readAgentRecordFromRpcBody(raw);
  return { data, agent, baseUrl };
}