/**
 * 共享的「agent 当前是否临时不可用」判据（429 限流中）。
 *
 * 判据：agent 记录的 nextAvailableAt 是有限数值且 > now，视为 429 限流冷却中，
 * 此刻不可用。nextAvailableAt 等于 now 视为已恢复。
 *
 * 供 list 过滤（CLI 与 ai/tools 列表）、准入判断等消费方复用，避免判据散落多份。
 */
export function isAgentUnavailableNow(
  agent:
    | { nextAvailableAt?: number } & Record<string, unknown>
    | null
    | undefined,
  now = Date.now(),
): boolean {
  const at = agent?.nextAvailableAt;
  return typeof at === "number" && Number.isFinite(at) && at > now;
}
