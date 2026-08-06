import { CORE_DRAIN_REASON } from ".//drainReason";
import { isGatewayHttpStatus } from ".//gatewayHttpStatus";

/**
 * 判定一个订阅/请求失败错误是否属于「部署窗口信号」。
 *
 * 部署（单机 alpha/main）时服务端进入 drain：新请求收 `503 core_draining`
 * （最长 30s 排空窗口），已连接的 SSE 流可能在窗口结束后被硬切（表现为
 * 「事件流意外关闭」这类无 HTTP status 的 retryable 错误），新进程冷启动
 * 期间的重连还可能撞上 502/503/504。
 *
 * 这些错误都值得走「长预算重试」（与 TUI/Web chat / background run start
 * 的 30 次预算对齐：1.5s × 30 ≈ 45s > drain 窗口），而不是几秒内放弃。
 *
 * 分类规则：
 * - `reason === core_draining`：服务端明示的部署窗口 → 长预算
 * - 带 HTTP status 且为 502/503/504（网关类）→ 长预算
 * - 无 status 的 retryable 错误（事件流意外关闭 / 连接失败，部署硬切与
 *   进程重启期间的主要形态）→ 长预算
 * - 其余（429/500 等带 status 的非网关错误，或非 retryable）→ 保持默认预算
 *
 * 纯函数、无依赖，便于各调用方与单测复用。
 */
export type RetrySignalLike = {
  retryable?: boolean;
  status?: number;
  reason?: string;
};

export function isDeployWindowRetrySignal(e: RetrySignalLike): boolean {
  if (e.reason === CORE_DRAIN_REASON) return true;
  if (typeof e.status === "number") return isGatewayHttpStatus(e.status);
  return e.retryable === true;
}
