import type { AgentRuntimeOptions } from "../../../ai/agent/types";
import {
  PERSONALIZATION_DIALOG_CATEGORY,
  buildPersonalizationRuntimeOptions,
} from "../../../ai/policy/personalizationDialog";
import type { DialogConfig } from "../../../app/types";
import { getPrimaryDialogAgentId } from "../dialogAgents";

export function resolveHandleSendMessageContext(input: {
  dialogConfig: DialogConfig;
  targetAgentKey?: string;
  runtimeOptions?: AgentRuntimeOptions;
}): {
  agentKeyToUse?: string;
  effectiveRuntimeOptions?: AgentRuntimeOptions;
} {
  const { dialogConfig, targetAgentKey, runtimeOptions } = input;
  const defaultAgentKey = getPrimaryDialogAgentId(dialogConfig) ?? undefined;

  return {
    agentKeyToUse: targetAgentKey || defaultAgentKey,
    effectiveRuntimeOptions:
      dialogConfig.category === PERSONALIZATION_DIALOG_CATEGORY
        ? buildPersonalizationRuntimeOptions(runtimeOptions)
        : runtimeOptions,
  };
}
