import type { AgentRuntimeOptions } from "../../../ai/agent/types";
import {
  PERSONALIZATION_DIALOG_CATEGORY,
  buildPersonalizationRuntimeOptions,
} from "../../../ai/policy/personalizationDialog";
import type { Agent, DialogConfig } from "../../../app/types";
import {
  resolveDialogRuntimeAgentConfig,
  resolveDialogRuntimeAgentKey,
} from "../dialogAgentPolicy";

export function resolveHandleSendMessageContext(input: {
  dialogConfig: DialogConfig;
  targetAgentKey?: string;
  runtimeOptions?: AgentRuntimeOptions;
}): {
  agentKeyToUse?: string;
  /**
   * auto 档位的执行配置，来自代码内置 profile。非空时发送路径直接用它，
   * 不去读 agentKeyToUse 对应的记录（那条记录按设计可以不存在）。
   */
  agentConfigToUse?: Agent;
  effectiveRuntimeOptions?: AgentRuntimeOptions;
} {
  const { dialogConfig, targetAgentKey, runtimeOptions } = input;

  return {
    agentKeyToUse: resolveDialogRuntimeAgentKey(dialogConfig, targetAgentKey),
    agentConfigToUse:
      resolveDialogRuntimeAgentConfig(dialogConfig, targetAgentKey) ?? undefined,
    effectiveRuntimeOptions:
      dialogConfig.category === PERSONALIZATION_DIALOG_CATEGORY
        ? buildPersonalizationRuntimeOptions(runtimeOptions ?? {})
        : runtimeOptions,
  };
}
