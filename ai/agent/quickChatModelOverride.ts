// quick-chat 自动模式「模型层覆盖」（web 侧入口）。
// 纯逻辑单一真相源在 agent-runtime/modelLayerOverride（CLI/server 共用）；
// 本文件只做 Agent 类型适配与 re-export，保持 web 既有 import 路径不变。

import type { Agent } from "../../app/types";
import {
  applyModelLayerOverride,
  buildModelLayerOverride,
  type ModelLayerOverride,
} from "../../agent-runtime/modelLayerOverride";

/**
 * 覆盖包：从收藏 agent 提取的 model 层字段 + 技能引用。
 * 全部为 plain data，可随 runtimeOptions 跨 thunk 传递。
 */
export type QuickChatModelOverride = ModelLayerOverride;

export { MODEL_LAYER_KEYS } from "../../agent-runtime/modelLayerOverride";

/**
 * 从收藏 agent 提取覆盖包。agent 缺少有效 provider/model 时返回 null
 * （调用方按「无覆盖」处理，走内置档位原样执行）。
 */
export function buildQuickChatModelOverride(
  agent: Pick<Agent, "provider" | "model"> & Partial<Agent>,
): QuickChatModelOverride | null {
  return buildModelLayerOverride(agent as Record<string, unknown>);
}

/**
 * 把覆盖包应用到档位 agent 配置上：替换 model 层字段，
 * 并把覆盖包的 references 合并进 base.references（dbKey 去重，base 优先）。
 * 不修改 base，返回新对象。
 */
export function applyQuickChatModelOverride(
  base: Agent,
  override: QuickChatModelOverride,
): Agent {
  return applyModelLayerOverride(
    base as unknown as Record<string, unknown>,
    override,
  ) as unknown as Agent;
}
