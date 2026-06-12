export const NOLO_DEFAULT_AGENT_ID = "01NOLOAPPBLD000000019KCKT0";
export const NOLO_DEFAULT_AGENT_KEY = `agent-pub-${NOLO_DEFAULT_AGENT_ID}`;
export const LOCAL_CODEX_AGENT_ID = "01LOCALCODEXCLI000000NEW";
export const LOCAL_CODEX_AGENT_KEY =
  `agent-local-${LOCAL_CODEX_AGENT_ID}`;
export const LOCAL_QODER_AGENT_ID = "01LOCALQODERCLI000000NEW";
export const LOCAL_QODER_AGENT_KEY =
  `agent-local-${LOCAL_QODER_AGENT_ID}`;

const AGENT_ALIAS_TO_KEY: Record<string, string> = {
  nolo: NOLO_DEFAULT_AGENT_KEY,
  default: NOLO_DEFAULT_AGENT_KEY,
  "default-nolo": NOLO_DEFAULT_AGENT_KEY,

  // Explicit local CLI agents. These are ordinary user-scoped agent records
  // that run through the current computer local runtime when unbound.
  "local-codex": LOCAL_CODEX_AGENT_KEY,
  "codex-local": LOCAL_CODEX_AGENT_KEY,
  "local codex": LOCAL_CODEX_AGENT_KEY,
  "local-qoder": LOCAL_QODER_AGENT_KEY,
  "qoder-local": LOCAL_QODER_AGENT_KEY,
  "local qoder": LOCAL_QODER_AGENT_KEY,
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
  return AGENT_ALIAS_TO_KEY[raw.trim().toLowerCase()] ?? parseAgentKeyFromInput(raw);
}

export function isLocalCliAgentKey(agentKey: string): boolean {
  return agentKey === LOCAL_CODEX_AGENT_KEY || agentKey === LOCAL_QODER_AGENT_KEY;
}
