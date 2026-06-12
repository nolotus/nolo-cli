// ai/tools/agent/updateAgentTool.ts

import type { RootState } from "../../../app/store";
import type { Agent } from "../../../app/types";
import { updateAgent } from "../../agent/agentSlice";
import { selectUserId } from "../../../auth/authSlice";
import {
    type UpdateAgentToolArgs,
    agentUpdateFieldSchemaProperties,
    assertAgentUpdateConfirmation,
    buildPatch,
    buildRawDataWithUpdateInfo,
    buildUpdateThunkPreviousAgent,
    extractAgentId,
    fetchAgentByDbKey,
    formatUpdatedAgentOutput,
    listRequestedFields,
    validateUpdateArgs,
} from "./agentUpdateShared";

export const updateAgentToolFunctionSchema = {
    name: "updateAgent",
    description:
        "根据给定配置更新一个指定的 Agent。该工具用于通用高权限维护，默认需要用户确认后才会执行。",
    parameters: {
        type: "object",
        properties: {
            agentId: {
                type: "string",
                description: "要更新的 Agent 的 dbKey，格式为 agent-{userId}-{id}。",
            },
            ...agentUpdateFieldSchemaProperties,
        },
        required: ["agentId"],
    },
};

// --- Executor ---

export async function updateAgentToolFunc(
    args: UpdateAgentToolArgs,
    thunkApi: any
): Promise<{ rawData: Agent; displayData: string }> {
    const state = thunkApi.getState() as RootState;
    const userId = selectUserId(state);
    const db = (thunkApi.extra as any)?.db;

    validateUpdateArgs(userId, { requireAgentId: true, agentId: args.agentId });

    const dbKey = args.agentId.trim();
    const previousAgent = await fetchAgentByDbKey(dbKey, db);

    if (!previousAgent) {
        throw new Error(
            `未找到 dbKey 为 "${dbKey}" 的 Agent。\n` +
            `如果您尝试更新旧版助手 (Cybot)，请新建一个 Agent 或在 UI 界面上手动迁移。`
        );
    }

    const agentId = extractAgentId(dbKey);
    const formData = buildPatch(args);
    const requestedFields = listRequestedFields(args);

    assertAgentUpdateConfirmation({
        scope: "generic",
        requestedFields,
        confirmed: args.__confirmedSelfEvolution === true,
    });

    const previousAgentForUpdate = buildUpdateThunkPreviousAgent(previousAgent, userId!);

    const agent = await thunkApi
        .dispatch(updateAgent({
            userId: userId!,
            agentId,
            formData,
            previousAgent: previousAgentForUpdate,
        }))
        .unwrap()
        .catch((e: any) => {
            throw new Error(`更新 Agent 失败：${e?.message ?? "未知错误"}`);
        });

    const rawDataWithUpdateInfo = buildRawDataWithUpdateInfo(
        agent,
        previousAgentForUpdate,
        requestedFields,
    );

    // TODO: Add a richer generic-agent-update preview/audit view before enabling any
    // field-level auto-approval for updateAgent. For now this tool stays confirmation-first.
    return {
        rawData: rawDataWithUpdateInfo as any,
        displayData: formatUpdatedAgentOutput(agent),
    };
}
