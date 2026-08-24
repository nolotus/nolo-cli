/**
 * Agent「429 限流可用性」的**唯一事实来源**：判据、复位时刻解析、状态决策。
 *
 * 消费方（全部只 import 本文件，禁止再各自实现）：
 * - `packages/server/agentAvailability/agentAvailability.ts` — server 侧落 DB
 * - `packages/cli/client/localRuntimeAdapter.ts` — CLI 本地 runtime 落本地记录
 * - `packages/ai/tools/noloWorkspaceReadTools.ts` / `packages/cli/agentListCommands.ts` — 列表过滤
 *
 * 本模块纯逻辑、零 I/O、不读系统时钟（`now` 一律由入参传入），因此 server / CLI /
 * web / desktop 都能直接 import；持久化由各端适配层负责。
 *
 * 历史教训（不要再拆回去）：CLI 与 server 曾各维护一份解析逻辑，导致 z.ai 的
 * 「周额度耗尽」修复只落在 CLI 一侧，server 侧同一个 bug continued to ship。
 */
import { parseResetsInMs } from "../tools/agent/quotaCircuitBreaker";

/** 无法从上游响应解析出复位时刻时使用的保守冷却窗口。 */
export const DEFAULT_PROVIDER_RETRY_MS = 5 * 60 * 1000;

/**
 * 共享的「agent 当前是否临时不可用」判据（429 限流中）。
 *
 * 判据：agent 记录的 nextAvailableAt 是有限数值且 > now，视为 429 限流冷却中，
 * 此刻不可用。nextAvailableAt 等于 now 视为已恢复。
 */
export function isAgentUnavailableNow(
  agent:
    | ({ nextAvailableAt?: number } & Record<string, unknown>)
    | null
    | undefined,
  now = Date.now(),
): boolean {
  const at = agent?.nextAvailableAt;
  return typeof at === "number" && Number.isFinite(at) && at > now;
}

function readRetryAfterTimestamp(body: unknown, now: number): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const raw = root.retryAfter ?? root.retry_after ?? root["Retry-After"];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : now + Math.max(0, raw) * 1000;
  }
  if (typeof raw === "string") {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return date;
  }
  return undefined;
}

function readResetTimestamp(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const error =
    root.error && typeof root.error === "object"
      ? (root.error as Record<string, unknown>)
      : root;
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : undefined;
  const raw = error.resets_at ?? error.resetsAt ?? details?.resets_at ?? details?.resetsAt;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 文案里的**绝对**复位时刻，例如 z.ai 的
 * `Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-27 12:05:49`。
 *
 * 必须先于相对时长兜底：周/月额度耗尽只给绝对时刻，落到默认 5 分钟窗口的话
 * agent 很快又被放回可选列表并再次撞 429。
 *
 * 取舍：无时区后缀的串按**本地时区**解析（`Date.parse` 语义）。上游多为与用户
 * 同区的服务，异地部署最多偏几小时，仍远优于 5 分钟兜底；刻意不引时区库。
 */
function parseResetAtText(value: string, now: number): number | undefined {
  const m = value.match(
    /resets?\s+at\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/i,
  );
  if (!m?.[1]) return undefined;
  const parsed = Date.parse(m[1]);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

/**
 * 把一次上游 429 响应解析成绝对的 epoch-ms 可用时刻。
 *
 * 优先级：Retry-After 头 → body 里的 retryAfter → resets_at/resetsAt →
 * 文案里的绝对 "reset at" → 文案里的相对时长 → 默认窗口。
 */
export function resolveNextAvailableAt(
  body: unknown,
  now: number,
  headers?: Headers | Record<string, string> | null,
): number {
  const headerRetryAfter =
    headers && typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : ((headers as Record<string, string> | null | undefined)?.["retry-after"] ??
        (headers as Record<string, string> | null | undefined)?.["Retry-After"]);
  const retryAfter = headerRetryAfter
    ? readRetryAfterTimestamp({ retryAfter: headerRetryAfter }, now)
    : readRetryAfterTimestamp(body, now);
  if (retryAfter !== undefined && retryAfter > now) return retryAfter;

  const absolute = readResetTimestamp(body);
  if (absolute !== undefined && absolute > now) return absolute;

  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return parseResetAtText(text, now) ?? now + (parseResetsInMs(text) ?? DEFAULT_PROVIDER_RETRY_MS);
}

export type AvailabilityAction =
  | { kind: "clear" }
  | { kind: "mark"; nextAvailableAt: number }
  | { kind: "noop" };

/**
 * 纯决策：把一次上游 status + body 映射成可用性动作。
 * 2xx → clear（恢复）；429 → mark（解析复位时刻）；
 * 5xx → mark（短默认窗口，避免反复打挂掉的 provider）；其余（1xx/3xx/4xx）→ noop。
 * 执行（读写记录）由各端适配层负责。
 */
export function resolveAvailabilityAction(
  status: number,
  body: unknown,
  now: number,
  headers?: Headers | Record<string, string> | null,
): AvailabilityAction {
  if (status >= 200 && status < 300) return { kind: "clear" };
  if (status === 429) {
    return { kind: "mark", nextAvailableAt: resolveNextAvailableAt(body, now, headers) };
  }
  if (status >= 500) {
    return { kind: "mark", nextAvailableAt: now + DEFAULT_PROVIDER_RETRY_MS };
  }
  return { kind: "noop" };
}

/**
 * 合并新旧冷却截止：取更晚者。
 *
 * 防的是「短冷却抹掉长冷却」——例如周额度耗尽已写入 3 天后的截止，随后一次 5xx
 * 只想标记 5 分钟，直接覆盖会让 agent 立刻被放回可选列表。
 */
export function mergeAvailabilityDeadline(
  currentDeadline: unknown,
  nextAvailableAt: number,
): number {
  return typeof currentDeadline === "number" && Number.isFinite(currentDeadline)
    ? Math.max(currentDeadline, nextAvailableAt)
    : nextAvailableAt;
}
