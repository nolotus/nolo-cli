/**
 * 内置平台 agent 的运行时路由（provider / model / 上游端点）——**叶子模块**。
 *
 * 刻意与 `builtinPlatformAgentConfigs.ts` 分开：chat proxy 这类服务端入口只需要
 * 这几个纯函数，不该为此把 agent-runtime 的配置层整个拉进依赖图（实测会形成
 * 循环导入，表现为运行时 "Export named ... not found"）。这里只依赖 core 的
 * catalog 与同层的端点表。
 */

import { builtinAgentCatalogEntryById } from "../core/builtinAgentCatalog";
import { isBuiltinPlatformAgentKey } from "../core/builtinAgents";
import { parsePublicAgentId } from "../core/prefix";
import {
  isOpenAiResponsesModel,
  resolvePlatformChatCompletionsEndpoint,
  resolvePlatformResponsesEndpoint,
} from "./platformProviderEndpoints";

/**
 * 平台内置 agent 的 provider/model：以 builtinAgentCatalog 为唯一真相源，
 * 即使数据库里存着别的值也以代码为准（内容归数据，运行时归代码）。
 */
export function resolveBuiltinAgentRuntimeFields(
  agentKey: string,
): { provider: string; model: string } | null {
  if (!isBuiltinPlatformAgentKey(agentKey)) return null;
  const entry = builtinAgentCatalogEntryById(parsePublicAgentId(agentKey));
  if (!entry) return null;
  return { provider: entry.provider, model: entry.model };
}

export type BuiltinPlatformAgentRoute = {
  provider: string;
  model: string;
  /**
   * 服务端自己解析出的上游端点。解析不出来时是 undefined——调用方应当让请求
   * 显式失败，**不要**沿用客户端传来的 url：客户端版本可能比服务端新，它算出
   * 的端点/模型服务端未必认识，照单全收正是 2026-08-22 那次 401 的成因
   * （客户端说 deepseek-v4-flash-vision-exp，服务端不认识这个 id，于是既没走
   * hosted 分支、又拿着客户端给的 DeepSeek 端点配了一把 provider 兜底 key）。
   */
  endpoint?: string;
};

/**
 * 内置平台 agent 的**服务端权威路由**：provider / model / 上游端点全部由
 * catalog 现算，不接受客户端输入。
 *
 * 为什么必须服务端算：chat proxy 的请求体里带着客户端算好的 `model` 和 `url`，
 * 而客户端（CLI / 桌面端 / web）的版本是任意的。只要两边对同一个 agent 算出
 * 不同答案，路由就会错位——错位的表现不是「报错说版本不匹配」，而是模型分流
 * 全部落空、退到 provider 级兜底 key，拿着 A 家的 key 去打 B 家的端点。
 *
 * 只覆盖 catalog 的 `group: "builtin"`。广场 public agent 仍按记录走——那些是
 * 用户可见可 fork 的商品，不是平台基础设施。
 */
export function resolveBuiltinPlatformAgentRoute(
  agentKey: string | undefined | null,
): BuiltinPlatformAgentRoute | null {
  const fields = resolveBuiltinAgentRuntimeFields(
    typeof agentKey === "string" ? agentKey : "",
  );
  if (!fields) return null;
  const endpoint = isOpenAiResponsesModel({
    provider: fields.provider,
    model: fields.model,
  })
    ? resolvePlatformResponsesEndpoint(fields.provider, fields.model)
    : resolvePlatformChatCompletionsEndpoint(fields.provider, fields.model);
  return {
    provider: fields.provider,
    model: fields.model,
    ...(endpoint ? { endpoint } : {}),
  };
}
