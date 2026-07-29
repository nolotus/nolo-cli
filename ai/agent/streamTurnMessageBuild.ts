// packages/ai/agent/streamTurnMessageBuild.ts
//
// 消息构建 + tool UI 投射 + desktop machine 路由 + dialog 元数据补丁。
// 从 streamAgentChatTurn.ts 提取——handler 调用前的消息/元数据准备层。
//
// 依赖：desktopTurnSegments（DesktopAssistantSegment）、projectDesktopToolUiContent、
// resolveRuntimeToolSurfaceForAgent、identity selectors、getIsDesktopApp。

import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedString } from "../../core/trimmedString";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { projectDesktopToolUiContent } from "./projectDesktopToolUiContent";
import {
    selectIdentityUserId,
} from "identity/selectors";
import { resolveRuntimeToolSurfaceForAgent } from "../../agent-runtime/runtimeToolSurface";
import { getIsDesktopApp } from "../../app/utils/env";
import { patch } from "../../database/dbSlice";
import type { Agent } from "../../app/types";
import type { RootState } from "../../app/store";

export const buildMessageMetadata = (
    agentConfig: Agent,
) => {
    const rawName = asTrimmedString(agentConfig?.name);
    return {
        agentKey: agentConfig.dbKey,
        cybotKey: agentConfig.dbKey,
        ...(rawName ? { agentName: rawName } : {}),
    };
};

export const buildDesktopRuntimeToolMessagesForUi = ({
    dialogId,
    turnMessages,
}: {
    dialogId: string;
    turnMessages?: any[];
}) => {
    if (!Array.isArray(turnMessages) || turnMessages.length === 0) return [];

    const toolNamesByCallId = new Map<string, string>();
    const activityByCallId = new Map<string, any>();

    const projected: any[] = [];

    for (const message of turnMessages) {
        if (Array.isArray(message?.tool_calls)) {
            for (const call of message.tool_calls) {
                const callId = asTrimmedString(call?.id);
                const toolName = asTrimmedString(call?.function?.name);
                if (callId && toolName) toolNamesByCallId.set(callId, toolName);

                // Extract _activity from tool call arguments for UI projection
                if (callId) {
                    try {
                        const args = typeof call?.function?.arguments === "string"
                            ? JSON.parse(call.function.arguments)
                            : call?.function?.arguments;
                        const rawActivity = isRecord(args) ? args._activity : undefined;
                        const activity = isRecord(rawActivity)
                            ? (rawActivity as Record<string, unknown>)
                            : undefined;
                        const legacyTitle = typeof activity?.title === "string" && activity.title.trim();
                        const action = activity?.action;
                        const actionTitle = isRecord(action) && typeof action.title === "string" && action.title.trim();
                        const plan = activity?.plan;
                        const hasPlan = isRecord(plan) && Array.isArray(plan.phases) && plan.phases.some((phase) => {
                            if (!isRecord(phase)) return false;
                            return typeof phase.title === "string" && !!phase.title.trim();
                        });
                        if (activity && (legacyTitle || actionTitle || hasPlan)) {
                            activityByCallId.set(callId, args._activity);
                        }
                    } catch {
                        // Ignore malformed tool call arguments
                    }
                }
            }
            continue;
        }

        if (message?.role !== "tool") continue;

        const toolCallId = asTrimmedString(message.tool_call_id);
        const metadata = asRecordOrEmpty(message.tool_result_metadata);
        const metadataToolName = asTrimmedString(metadata.toolName);
        const toolName = metadataToolName || (toolCallId ? toolNamesByCallId.get(toolCallId) : "") || "tool";
        const { key: dbKey, messageId } = createDialogMessageKeyAndId(dialogId);

        // Resolve activity: prefer tool result metadata.activity, fall back to tool call _activity
        const resultActivity = metadata.activity && typeof metadata.activity === "object"
            ? metadata.activity
            : undefined;
        const callActivity = toolCallId ? activityByCallId.get(toolCallId) : undefined;
        const activity = resultActivity || callActivity;

        // Merge activity into metadata so UI readers (ToolMessageGroup /
        // buildActivityTimeline) that look at message.metadata.activity see it.
        const mergedMetadata = activity ? { ...metadata, activity } : metadata;

        projected.push({
            id: messageId,
            dialogId,
            dbKey,
            role: "tool",
            content: projectDesktopToolUiContent({
                toolName,
                content: typeof message.content === "string" ? message.content : "",
                metadata: mergedMetadata,
            }),
            isStreaming: false,
            toolName,
            ...(toolCallId ? { toolCallId } : {}),
            ...(Object.keys(mergedMetadata).length ? { metadata: mergedMetadata } : {}),
        });
    }

    return projected;
};

/**
 * A tool row is only written to the DB when it has content; the stop/error
 * paths drop empty ones via removeTransientMessage. Shared by both paths so
 * the assistant's declared tool_calls can never outlive their result rows.
 */
export const toolMessageWillPersist = (toolMsg: unknown): boolean => {
    const content = (toolMsg as any)?.content;
    if (typeof content === "string") return content.trim().length > 0;
    return Array.isArray(content) && content.length > 0;
};

export const shouldUseDesktopLocalRuntime = (
    agentConfig: Partial<Agent> | null | undefined,
) => {
    if (!getIsDesktopApp()) return false;
    return agentConfig?.apiSource !== "cli";
};

export const readCurrentDesktopMachineId = () => {
    const fromProcess = typeof process !== "undefined"
        ? (process.env?.NOLO_CURRENT_MACHINE_ID || process.env?.NOLO_MACHINE_ID || "").trim()
        : "";
    if (fromProcess) return fromProcess;
    const w = typeof globalThis !== "undefined" && (globalThis as any).window
        ? (globalThis as any).window
        : null;
    const fromWindow = asTrimmedString(w?.__NOLO_CURRENT_MACHINE_ID__)
        || asTrimmedString(w?.__NOLO_MACHINE_ID__);
    return fromWindow;
};

export const resolveRemoteBoundMachineId = (machineId: string) => {
    if (!machineId || !getIsDesktopApp()) return machineId;
    const currentMachineId = readCurrentDesktopMachineId();
    return currentMachineId && currentMachineId === machineId ? "" : machineId;
};

export const resolveWebAgentRuntimeToolSurface = (
    agentConfig: Agent,
    state: RootState,
): Agent => {
    const toolSurface = resolveRuntimeToolSurfaceForAgent({
        explicitToolNames: Array.isArray((agentConfig as any).tools)
            ? (agentConfig as any).tools
            : [],
        currentUserId: selectIdentityUserId(state),
        agentOwnerId: typeof (agentConfig as any).userId === "string"
            ? (agentConfig as any).userId
            : null,
        agentKey: (agentConfig as any).dbKey ?? (agentConfig as any).agentKey,
        isPublic: (agentConfig as any).isPublic === true,
        sharingLevel: typeof (agentConfig as any).sharingLevel === "string"
            ? (agentConfig as any).sharingLevel
            : null,
        runtimeHost: "web",
    });
    return {
        ...agentConfig,
        tools: toolSurface.finalToolNames,
        runtimeToolSurface: toolSurface,
    } as Agent;
};

export const formatMachineAgentRunError = async (response: Response): Promise<string> => {
    const errorText = await response.text();
    let payload: any = null;
    try {
        payload = errorText ? JSON.parse(errorText) : null;
    } catch {
        payload = null;
    }

    const reason = typeof payload?.reason === "string" ? payload.reason : "";
    if (response.status === 409) {
        if (reason === "bound_machine_unavailable") {
            return "绑定的电脑不在线。请确认这台电脑已开机并重新运行连接命令。";
        }
        if (reason === "bound_machine_owner_mismatch") {
            return "这台电脑是在线的，但当前账号和 Agent 绑定账号不一致。请重新绑定 Agent，或在绑定账号下重新连接这台电脑。";
        }
        if (reason === "connector_offline") {
            return "电脑在线，但连接器未连接。请在这台电脑上重新运行连接命令后再试。";
        }
        if (reason === "missing_capability") {
            return "这台电脑没有对应的 CLI 能力。请安装对应 CLI，或把 Agent 绑定到另一台电脑。";
        }
    }

    const message =
        asOptionalTrimmedString(payload?.message) ??
        asOptionalTrimmedString(payload?.error) ??
        errorText.trim();
    return message || `Machine agent run failed (${response.status})`;
};

export const normalizeThreadMetadataPatch = (value: unknown) => {
    if (!isRecord(value)) return null;
    const record = value;
    const changes: Record<string, string> = {};
    const threadKind = asOptionalTrimmedString(record.threadKind);
    if (threadKind) {
        changes.threadKind = threadKind;
    }
    const presentationIntent = asOptionalTrimmedString(record.presentationIntent);
    if (presentationIntent) {
        changes.presentationIntent = presentationIntent;
    }
    return Object.keys(changes).length > 0 ? changes : null;
};

export const patchDialogThreadMetadata = async (
    dispatch: any,
    dialogKey: string,
    metadata: unknown,
) => {
    const changes = normalizeThreadMetadataPatch(metadata);
    if (!changes) return;
    await dispatch(
        patch({
            dbKey: dialogKey,
            changes,
        }),
    ).unwrap?.();
};

export const patchDialogActiveAgent = async (
    dispatch: any,
    dialogKey: string,
    agentKey: unknown,
) => {
    if (typeof agentKey !== "string" || !agentKey.trim()) return;
    await dispatch(
        patch({
            dbKey: dialogKey,
            changes: {
                primaryAgentKey: agentKey.trim(),
            },
        }),
    ).unwrap?.();
};

export function appendCliCapabilityWarnings(content: string, warnings: string[]): string {
    if (!warnings.length) return content;
    const warningBlock = `\n\n[CLI 能力提示]\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
    return `${content}${warningBlock}`;
}