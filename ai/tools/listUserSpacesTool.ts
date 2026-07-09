// 文件路径: ai/tools/listUserSpacesTool.ts

/**
 * listUserSpaces 工具
 * 
 * 用于 AI 获取当前用户可访问的所有 Space 列表（概览）。
 * 只返回 Space 名称和 ID，不返回详细内容，避免 Token 爆炸。
 * 
 * 使用场景：
 * - 用户询问"我有哪些空间"
 * - AI 需要确定要查询哪个 Space
 * - 跨 Space 导航
 */

import type { RootState } from "../../app/store";
import { selectAllMemberSpaces } from "../../create/space/spaceSlice";

// ---- Types ----

export type ListUserSpacesArgs = {
    /**
     * 是否只返回用户拥有的 Space（角色为 owner）
     */
    ownedOnly?: boolean;
};

// ---- 工具 Schema，供 LLM 调用 ----

export const listUserSpacesFunctionSchema = {
    name: "listUserSpaces",
    description: [
        "获取当前用户可访问的所有 Space（工作空间）列表。",
        "",
        "返回内容：",
        "- 每个 Space 的 ID 和名称",
        "- 用户在该 Space 的角色（owner/member）",
        "",
        "使用场景：",
        "- 用户询问'我有哪些空间'",
        "- 需要确定要查询哪个 Space",
        "- 跨 Space 导航",
        "",
        "注意：只返回概览信息，如需查看 Space 详细内容，使用 listSpaceContent 工具。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            ownedOnly: {
                type: "boolean",
                description: "是否只返回用户拥有的 Space。默认 false（返回所有可访问的 Space）。",
                default: false,
            },
        },
        required: [],
    },
};

// ---- 执行函数 ----

export async function listUserSpacesFunc(
    args: ListUserSpacesArgs,
    thunkApi: any,
    context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData?: string }> {
    const { ownedOnly = false } = args || {};

    try {
        const { getState } = thunkApi;
        const state: RootState = getState();

        type MemberSpaceRow = {
            spaceId: string;
            spaceName?: string;
            role?: string;
        };
        // Selector typing can collapse membership fields under partial RootState shapes.
        let memberSpaces = selectAllMemberSpaces(state) as MemberSpaceRow[];

        if (ownedOnly) {
            memberSpaces = memberSpaces.filter((ms) => ms.role === "owner");
        }

        if (memberSpaces.length === 0) {
            return {
                rawData: { spaces: [] },
                displayData: ownedOnly
                    ? "当前用户没有拥有任何 Space。"
                    : "当前用户没有可访问的 Space。",
            };
        }

        // 格式化输出
        let resultText = `=== 用户可访问的 Space 列表 (${memberSpaces.length}) ===\n\n`;

        const spacesData = memberSpaces.map((ms, index) => {
            const roleLabel = ms.role === "owner" ? "👑 Owner" : "👤 Member";
            resultText += `${index + 1}. ${ms.spaceName || ms.spaceId}\n`;
            resultText += `   ID: ${ms.spaceId} | Role: ${roleLabel}\n`;

            return {
                spaceId: ms.spaceId,
                name: ms.spaceName || ms.spaceId,
                role: ms.role,
            };
        });

        resultText += `\n提示：使用 listSpaceContent(spaceId) 可查看指定 Space 的详细内容。`;

        return {
            rawData: { spaces: spacesData },
            displayData: resultText,
        };
    } catch (error: any) {
        console.error("执行 listUserSpaces 工具时发生错误:", error);
        throw new Error(
            `获取用户 Space 列表失败：${error?.message || String(error)}`
        );
    }
}
