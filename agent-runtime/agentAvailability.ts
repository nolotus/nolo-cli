export const DEFAULT_PROVIDER_RETRY_MS = 5 * 60 * 1000;

function parseResetText(value: string): number | undefined {
  const m = value.match(/(?:resets?\s+in|retry[- ]after)\s*(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?\s*(?:(\d+)\s*sec)?/i);
  if (!m) return undefined;
  return ((Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0)) * 1000;
}

export function resolveAgentNextAvailableAt(body: unknown, now = Date.now()): number {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  const details = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : undefined;

  // 1. First priority: retry-after (relative seconds offset or ISO string)
  const retryRaw = error.retryAfter ?? error.retry_after ?? error["Retry-After"];
  if (typeof retryRaw === "number" && Number.isFinite(retryRaw)) {
    return retryRaw > 1e12 ? retryRaw : now + Math.max(0, retryRaw) * 1000;
  }
  if (typeof retryRaw === "string") {
    const numeric = Number(retryRaw.trim());
    if (Number.isFinite(numeric)) return now + Math.max(0, numeric) * 1000;
    const date = Date.parse(retryRaw);
    if (Number.isFinite(date) && date > now) return date;
  }

  // 2. Second priority: resets_at / resetsAt (absolute timestamp in epoch seconds or ms)
  const resetRaw = error.resets_at ?? error.resetsAt ?? details?.resets_at ?? details?.resetsAt;
  if (typeof resetRaw === "number" && Number.isFinite(resetRaw)) {
    const absolute = resetRaw > 1e12 ? resetRaw : resetRaw * 1000;
    if (absolute > now) return absolute;
  }
  if (typeof resetRaw === "string") {
    const parsed = Date.parse(resetRaw);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }

  // 3. Fallback: textual match or default
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return now + (parseResetText(text) ?? DEFAULT_PROVIDER_RETRY_MS);
}

export function isAgentCoolingDown(agent: unknown, now = Date.now()): boolean {
  const at = agent && typeof agent === "object" ? (agent as Record<string, unknown>).nextAvailableAt : undefined;
  return typeof at === "number" && Number.isFinite(at) && at > now;
}
