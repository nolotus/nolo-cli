import type { AgentRuntimeOptions } from "../../../ai/agent/types";
import {
  PERSONALIZATION_DIALOG_CATEGORY,
  buildPersonalizationRuntimeOptions,
} from "../../../ai/policy/personalizationDialog";
import type { DialogConfig } from "../../../app/types";
import { resolveDialogRuntimeAgentKey } from "../dialogAgentPolicy";

export function resolveHandleSendMessageContext(input: {
  dialogConfig: DialogConfig;
  targetAgentKey?: string;
  runtimeOptions?: AgentRuntimeOptions;
}): {
  agentKeyToUse?: string;
  effectiveRuntimeOptions?: AgentRuntimeOptions;
} {
  const { dialogConfig, targetAgentKey, runtimeOptions } = input;

  return {
    agentKeyToUse: resolveDialogRuntimeAgentKey(dialogConfig, targetAgentKey),
    effectiveRuntimeOptions:
      dialogConfig.category === PERSONALIZATION_DIALOG_CATEGORY
        ? buildPersonalizationRuntimeOptions(runtimeOptions ?? {})
        : runtimeOptions,
  };
}
