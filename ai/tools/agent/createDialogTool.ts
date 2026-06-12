// 文件路径: ai/tools/agent/createDialogTool.ts

import type { RootState } from "../../../app/store";
import { createDialogAction } from "../../../chat/dialog/actions/createDialogAction";
import { streamAgentChatTurn } from "../../agent/agentSlice";

export const createDialogFunctionSchema = {
    name: "createDialog",
    description:
        "创建一个新的对话（Dialog），可以指定由哪个 Agent 来响应，并可选地发送第一条消息触发 Agent 立即执行。" +
        "常用于：派生子任务对话、让某个专用 Agent 在后台处理问题、睡前布置任务等场景。" +
        "返回 dialogId，可通过 read({ dbKey: dialogId }) 随时查看对话结果。",
    parameters: {
        type: "object",
        properties: {
            agentKey: {
                type: "string",
                description: "负责响应这个对话的 Agent ID（dbKey，格式如 agent-xxx）。",
            },
            firstMessage: {
                type: "string",
                description: "可选。创建对话后立即发送的第一条消息，Agent 会自动开始执行。如果不传则只创建空对话。",
            },
            title: {
                type: "string",
                description: "可选。对话标题，方便后续识别。",
            },
        },
        required: ["agentKey"],
    },
};

export const createDialogFunc = async (
    args: { agentKey: string; firstMessage?: string; title?: string },
    context: { getState: () => RootState; dispatch: any }
) => {
    const { agentKey, firstMessage, title } = args;
    const { getState, dispatch } = context;

    const dialogConfig = await createDialogAction(
        {
            // TODO: 后续改为 [agentKey, ...subAgents] 组合，支持多 Agent 协作
            // 目前仅使用主 agentKey 作为 cybots[0]
            cybots: [agentKey],
            title: title ?? `Dialog with ${agentKey}`,
        },
        { getState, dispatch }
    );

    const dialogId = dialogConfig.id;

    if (firstMessage) {
        void dispatch(
            streamAgentChatTurn({
                agentKey,
                userInput: firstMessage,
                dialogKey: dialogConfig.dbKey,
            })
        );
    }

    return {
        dialogId,
        dialogKey: dialogConfig.dbKey,
        message: firstMessage
            ? `已创建对话并发送任务，Agent 正在后台执行。可通过 read({ dbKey: "${dialogConfig.dbKey}" }) 查看进度。`
            : `已创建空对话。可通过 read({ dbKey: "${dialogConfig.dbKey}" }) 查看。`,
    };
};
