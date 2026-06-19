// packages/server/handlers/agentRun/types.ts

import type {
    DialogPolicyState,
} from "../../../ai/policy/types";
import type { ResolvedRuntimePolicy } from "../../../ai/policy/runtimePolicy";
import type { DialogRuntimeProfile } from "../../../app/types";
import type { DialogSubjectRef } from "../../../app/types";
import type {
    AgentRuntimeChatMessage,
    AgentRuntimeResult,
    AgentRuntimeToolCall,
} from "../../../agent-runtime/types";
import type { AgentRuntimeOptions } from "../../../ai/agent/types";

export type ChatMessage = AgentRuntimeChatMessage;

export type AssistantToolCall = AgentRuntimeToolCall;

export type AgentRunUserInputReferencePart = {
    type: string;
    name?: string;
    pageKey?: string;
    dialogKey?: string;
};

export type AgentRunUserInputPart =
    | { type: "text"; text: string }
    | {
        type: "image_url";
        image_url: { url: string };
        google_native?: {
            inlineData?: {
                mimeType: string;
                data: string;
            };
            thoughtSignature?: string;
        };
    }
    | AgentRunUserInputReferencePart;

export interface AgentRunRequest {
    agentKey: string;
    userInput: string | AgentRunUserInputPart[];
    messages?: ChatMessage[]; // 历史对话，调用方自行管理（不持久化）
    runtimeContext?: AgentRunRuntimeContext;
    stream?: boolean;
    timeoutMs?: number; // 可选：调用方为本次 agent run 传入的任务级超时预算
    background?: boolean;
    spaceId?: string;
    category?: string;
    inheritedFromDialogKey?: string;
    parentDialogId?: string;
    runtimeProfile?: DialogRuntimeProfile;
    runtimeOptions?: AgentRuntimeOptions;
    debugContextLayers?: boolean;
    /** 传入已有 dialogId 时，新消息追加到该对话而不是新建 */
    continueDialogId?: string;
    /** UI 已自行管理消息持久化时，设为 false 避免 agent/run 额外创建运行对话 */
    persistDialog?: boolean;
    /** persistDialog=false 时用于工具上下文和计费归属的已有 UI dialogId */
    clientDialogId?: string;
}

export interface AgentRunRuntimeContext {
    surface?: "web" | "electron" | "electron-bun" | "cli" | "server-script" | "backend-script" | "react-native" | string;
    host?: string;
    runtime?: string;
    entrypoint?: string;
    capabilities?: string[];
    subjectRefs?: DialogSubjectRef[];
    allowedChildAgentKeys?: string[];
    allowedToolNames?: string[];
    threadKind?: string;
    presentationIntent?: string;
    parentThreadId?: string;
    rootThreadId?: string;
}

export interface LoopResult extends Omit<AgentRuntimeResult, "policyState"> {
    policyState?: DialogPolicyState;
    artifacts?: unknown;
    activeAgentKey?: string;
    threadMetadata?: {
        threadKind?: AgentRunRuntimeContext["threadKind"];
        presentationIntent?: AgentRunRuntimeContext["presentationIntent"];
    };
}

export interface ToolPolicyRuntimeState {
    autoKnowledgeCaptureCountThisRun: number;
    autoSpaceReadCountThisRun: number;
}

export interface ToolExecutionContext {
    policy?: ResolvedRuntimePolicy;
    runtimeState?: ToolPolicyRuntimeState;
    runtimeToolSurface?: {
        finalToolNames?: unknown;
        explicitToolNames?: unknown;
        injectedToolNames?: unknown;
        auditReason?: unknown;
    } | null;
    runtimeContext?: AgentRunRuntimeContext | null;
    userId?: string | null;
    agentKey?: string | null;
    dialogId?: string | null;
    currentSpaceId?: string | null;
    userInput?: string | null;
    imageUrls?: string[];
    hostedWorkspaceLease?: Record<string, unknown> | null;
}
