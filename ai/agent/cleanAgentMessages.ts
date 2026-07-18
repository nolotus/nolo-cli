// 文件路径: ai/agent/cleanAgentMessages.ts

import type { Message } from "../../chat/messages/types";

/**
 * 判断消息的文本内容是否“为空”（对人没意义）
 */
const isEmptyContent = (content: unknown): boolean => {
    if (content == null) return true;

    if (typeof content === "string") {
        return content.trim().length === 0;
    }

    if (Array.isArray(content)) {
        return content.length === 0;
    }

    return false;
};

/**
 * 为指定 Agent 构造“安全”的消息视图:
 *
 * 分层目标：
 * - 这一层是「对话视角清洗」，不直接关心 OpenAI/Azure 精确协议，只关心：
 *   1）当前 Agent 能看到什么历史；
 *   2）哪些内部 plumbing 信息需要隐藏。
 *
 * 约定：
 * - 所有 Agent：
 *   - 丢弃「assistant 且 content 为空 且 没有 tool 调用」的消息（通常是 streaming 占位，没实际内容）
 *
 * - 当前 Agent（消息的 cybotKey 字段匹配）：
 *   - user / assistant / tool 消息：原样保留（保证自己工具链完整）
 *   - 特别地：即使 assistant 只有 tool 调用、没有文本，也要保留
 *
 * - 其它 Agent：
 *   - assistant 消息：
 *       - 删除所有 tool 调用字段（tool_calls / toolCalls），避免跨 Agent 的 call_id 冲突；
 *       - 使用 agentName 作为前缀，生成可读文本：
 *         - 有原始文本：`【AgentName】 原文...`
 *         - 没有原始文本：`【AgentName】（使用了工具生成回复）`
 *   - tool 消息：直接丢弃（内部 plumbing，对当前 Agent 没意义）
 *
 * - 其它角色（system 等）：原样保留
 */
export const buildAgentViewMessages = (
    allMessages: Message[],
    currentAgentKey: string
): Message[] => {
    const result: Message[] = [];

    for (const msg of allMessages) {
        if (!msg) continue;

        const role = (msg as any).role;
        if (!role) continue;

        // 同时兼容内部字段 toolCalls 和 OpenAI 标准字段 tool_calls
        const hasToolCalls =
            (Array.isArray((msg as any).tool_calls) &&
                (msg as any).tool_calls.length > 0) ||
            (Array.isArray((msg as any).toolCalls) &&
                (msg as any).toolCalls.length > 0);

        const empty = isEmptyContent((msg as any).content);

        // 1. 统一丢弃“空 assistant 且没有 tool 调用”的消息
        //    - 对所有 Agent 一视同仁，这类通常是 streaming 中途写入的占位，没实际内容
        if (role === "assistant" && empty && !hasToolCalls) {
            continue;
        }

        const isCurrentAgent = (msg as any).cybotKey === currentAgentKey;

        // ---- 用户消息：所有 Agent 都需要完整历史 ----
        if (role === "user") {
            result.push(msg);
            continue;
        }

        // ---- 助手消息 ----
        if (role === "assistant") {
            if (isCurrentAgent) {
                // 当前 Agent 自己的历史回复：原样保留（包含 toolCalls / tool_calls）
                result.push(msg);
            } else {
                // 其它 Agent 的回复：降级为纯文本 + 前缀，不再携带任何 tool 调用字段
                const cloned: Message = { ...(msg as any) } as Message;

                // 删掉所有工具调用字段，避免跨 Agent 的 call_id 污染
                if ((cloned as any).tool_calls) {
                    delete (cloned as any).tool_calls;
                }
                if ((cloned as any).toolCalls) {
                    delete (cloned as any).toolCalls;
                }

                const rawAgentName = (cloned as any).agentName;
                const agentName =
                    rawAgentName && String(rawAgentName).trim()
                        ? String(rawAgentName).trim()
                        : "其他 Agent";

                if (typeof cloned.content === "string") {
                    const trimmed = cloned.content.trim();
                    if (trimmed) {
                        cloned.content = `【${agentName}】 ${trimmed}`;
                    } else {
                        cloned.content = `【${agentName}】（使用了工具生成回复）`;
                    }
                } else {
                    // 非字符串内容（理论上很少见），同样给一个占位说明
                    cloned.content = `【${agentName}】（使用了工具生成回复）`;
                }

                result.push(cloned);
            }
            continue;
        }

        // ---- 工具消息 ----
        if (role === "tool") {
            if (isCurrentAgent) {
                // 当前 Agent 自己的 tool 消息：保留，保证工具调用链可用
                result.push(msg);
            } else {
                // 其它 Agent 的 tool 消息：全部丢弃，避免跨 Agent / 跨 provider 的 call_id 冲突
                continue;
            }
            continue;
        }

        // ---- 其它角色（system 等） ----
        result.push(msg);
    }

    return result;
};