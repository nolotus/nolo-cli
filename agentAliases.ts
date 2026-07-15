import { asTrimmedLowercaseString } from "./core/trimmedLowercaseString";

export const CURRENT_OPERATOR_USER_ID = "0e95801d90";
export const NOLO_DEFAULT_AGENT_ID = "01NOLOAPPBLD000000019KCKT0";
export const NOLO_DEFAULT_AGENT_KEY = `agent-pub-${NOLO_DEFAULT_AGENT_ID}`;
export const NOLO_PROJECT_MANAGER_AGENT_ID = "01NOLOPROJMGR00000000MSVGG";
export const NOLO_PROJECT_MANAGER_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${NOLO_PROJECT_MANAGER_AGENT_ID}`;
export const NOLO_FRONTEND_AGENT_ID = "01FRONTENDAG0000000115N4E1";
export const NOLO_FRONTEND_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${NOLO_FRONTEND_AGENT_ID}`;
export const LOCAL_CODEX_AGENT_ID = "01LOCALCODEXCLI000000NEW";
export const LOCAL_CODEX_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${LOCAL_CODEX_AGENT_ID}`;

const AGENT_ALIAS_TO_KEY: Record<string, string> = {
  nolo: NOLO_DEFAULT_AGENT_KEY,
  default: NOLO_DEFAULT_AGENT_KEY,
  "default-nolo": NOLO_DEFAULT_AGENT_KEY,

  // Product implementation & coordination aliases
  "frontend-implementer": NOLO_FRONTEND_AGENT_KEY,
  "frontend-agent": NOLO_FRONTEND_AGENT_KEY,
  frontend: NOLO_FRONTEND_AGENT_KEY,
  "frontend agent": NOLO_FRONTEND_AGENT_KEY,
  "前端agent": NOLO_FRONTEND_AGENT_KEY,
  "前端 agent": NOLO_FRONTEND_AGENT_KEY,
  "project-manager": NOLO_PROJECT_MANAGER_AGENT_KEY,
  pm: NOLO_PROJECT_MANAGER_AGENT_KEY,

  // Explicit local CLI agents. These are ordinary private agent records that
  // run through the current computer local runtime when unbound.
  "local-codex": LOCAL_CODEX_AGENT_KEY,
  "codex-local": LOCAL_CODEX_AGENT_KEY,
  "local codex": LOCAL_CODEX_AGENT_KEY,
  "minimax-m3": "agent-0e95801d90-minimax-m3",
  minimax: "agent-0e95801d90-minimax-m3",
};

function parseAgentKeyFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\/+/, "");
  }
  return trimmed;
}

export function resolveCliAgentKeyInput(raw: string): string {
  return AGENT_ALIAS_TO_KEY[asTrimmedLowercaseString(raw)] ?? parseAgentKeyFromInput(raw);
}

export function isLocalCliAgentKey(agentKey: string): boolean {
  return agentKey === LOCAL_CODEX_AGENT_KEY;
}