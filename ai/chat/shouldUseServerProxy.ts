import type { Agent } from "../../app/types";

export const shouldUseServerProxy = (
  agentConfig: Pick<Agent, "provider" | "useServerProxy">,
  requestProvider?: string
): boolean => {
  const effectiveProvider = (requestProvider || agentConfig.provider || "").toLowerCase();

  // Google requests are forced through the server proxy for now because the
  // native Gemini image bridge, provider fallback, and request translation live
  // on the server. Keep this centralized so we can later add direct/custom-url
  // opt-out for user-managed keys without having to update web/native twice.
  if (effectiveProvider === "google") {
    return true;
  }

  return !!agentConfig.useServerProxy;
};
