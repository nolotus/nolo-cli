/**
 * CLI `nolo chat --auto-route` 的路由目标。
 *
 * 「自动路由」早已不再分类：没有 LLM 分类器、没有复杂度分档、没有图片档
 * （图片交给 vision 预处理管道，见 localLoop 的 preprocessImagesForTextOnlyAgent）。
 * 剩下的全部语义就是一句「走默认档」，所以这里只留一个常量。
 *
 * 曾经这里有 `CLI_AUTO_TIER_AGENT_KEYS` / `CLI_AUTO_TIER_MODELS` 两张三档表
 * （flash/balanced/quality 三个值完全相同）、一个把三档判成同一件事的
 * `resolveCliAutoAgentModel`，以及 `classifyCliAutoRoute`——它忽略入参、恒定
 * 返回 flash，而调用方只读 `agentKey` 一个字段。档位是历史形状，不是功能。
 *
 * 目标与 web 首页默认档保持一致（app/settings/quickChatTierDefaults.ts）：
 * 都指向内置 nolo 本体，它的 provider/model 由 builtinAgentCatalog 托管。
 */

import { BUILTIN_NOLO_AGENT_KEY } from "../../core/builtinAgents";

/** `--auto-route` / `NOLO_AUTO_ROUTE=1` 时实际使用的 agent。 */
export const CLI_AUTO_ROUTE_AGENT_KEY = BUILTIN_NOLO_AGENT_KEY;
