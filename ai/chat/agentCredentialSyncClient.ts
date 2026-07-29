// packages/ai/chat/agentCredentialSyncClient.ts
//
// Client-side helpers for the optional custom api-key server sync store.
// Transport-agnostic (plain fetch) so Web, RN, and CLI can reuse them.
// Auth is bound by the caller (currentServer + authToken) — these helpers
// never read global auth state.

export type AgentCredentialSyncContext = {
  currentServer: string;
  authToken: string;
};

function buildUrl(currentServer: string, credentialRef: string): string {
  return `${currentServer}/api/agent-credentials/${encodeURIComponent(credentialRef)}`;
}

/**
 * Fetch a synced custom api-key from the server store. Returns plaintext key
 * or null when not found / unreachable. Never throws — callers treat a missing
 * key as a normal broker miss.
 */
export async function fetchServerSyncedCredential(
  ctx: AgentCredentialSyncContext,
  credentialRef: string,
): Promise<string | null> {
  try {
    const res = await fetch(buildUrl(ctx.currentServer, credentialRef), {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { apiKey?: string };
    return data.apiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete a synced custom api-key from the server store. Best-effort; never
 * throws (agent deletion must not be blocked by a network cleanup failure).
 */
export async function deleteServerSyncedCredential(
  ctx: AgentCredentialSyncContext,
  credentialRef: string,
): Promise<boolean> {
  try {
    const res = await fetch(buildUrl(ctx.currentServer, credentialRef), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Push (encrypt + store) a custom api-key to the server sync store.
 * Used by the agent create/update flow when the user opts into sync.
 * Returns true on success.
 */
export async function pushServerSyncedCredential(
  ctx: AgentCredentialSyncContext,
  credentialRef: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const res = await fetch(buildUrl(ctx.currentServer, credentialRef), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.authToken}`,
      },
      body: JSON.stringify({ apiKey }),
    });
    return res.ok;
  } catch {
    return false;
  }
}