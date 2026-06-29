export const ADVANCED_FEATURE_MIN_BALANCE = 19;
export const GPT_PRO_REQUIRED_RECHARGE_AMOUNT = 199;

export function isGptProModel(provider: unknown, model: unknown): boolean {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedModel = String(model || "").trim().toLowerCase();
  if (normalizedProvider === "openai") {
    return /^gpt-[a-z0-9.]+-pro(?:-|$)/.test(normalizedModel);
  }
  if (normalizedProvider === "deepinfra") {
    return normalizedModel.includes("claude") && normalizedModel.includes("opus");
  }
  return false;
}

export const GPT_PRO_BLOCKED_MESSAGE = `GPT Pro 系列需要先开通 ${GPT_PRO_REQUIRED_RECHARGE_AMOUNT} 积分档位。`;

/**
 * 客户端侧：判断当前 agent 是否因 GPT Pro 资格不足被拦截。
 * 只检查用户记录的 gptProAccess.status，不扫描交易历史。
 * 服务端有独立的 hasGptProTierAccess（会扫历史充值），不共用此函数。
 */
export function shouldBlockForGptPro(
  agent: { provider?: unknown; model?: unknown; apiSource?: unknown } | null | undefined,
  gptProStatus: string | undefined,
): { blocked: false } | { blocked: true; message: string } {
  if (!agent) return { blocked: false };
  if (agent.apiSource === "cli") return { blocked: false };
  if (!isGptProModel(agent.provider, agent.model)) return { blocked: false };
  if (gptProStatus === "active") return { blocked: false };
  return { blocked: true, message: GPT_PRO_BLOCKED_MESSAGE };
}
