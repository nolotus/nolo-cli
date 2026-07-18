// 文件路径: packages/chat/dialog/actions/extractReferenceKeys.ts
//
// 统一从一条消息里抽取可被 fetchReferenceContents 加载的引用 dbKey。
//
// 背景：压缩时提取 referenceKeys 和 getFullChatContextKeys 实时扫描历史消息
// 原本都只看 msg.content 的 pageKey/dialogKey，完全忽略 tool_calls 和
// tool result 的 toolPayload.input。而 agent 在工具调用里大量通过参数引用
// page/dialog/table/agent 等 dbKey（readDoc { pageKey }、readAgent { agentKey }、
// queryDialogsBySubjectRef { rowDbKey } …）。一旦这些消息被压缩，引用就永久丢失，
// 后续 turn 拿不到完整上下文。
//
// 这里抽出一个共享函数，覆盖三种来源：
//   1. msg.content（array / object）的 pageKey、dialogKey
//   2. assistant 消息的 tool_calls[].function.arguments（JSON string）里的 key 字段
//   3. tool result 消息的 toolPayload.input（以及 rawToolCall.function.arguments）里的 key 字段
//
// 只保留 fetchReferenceContents 实际能格式化的类型：page、dialog record、table meta。
// agent/space/file 等 key 喂给 fetchReferenceContents 只会返回 null，不收。

import { isPageKey, isDialogRecordKey, isTableMetaKey } from "../../../database/keys";
import { isRecord } from "../../../core/isRecord";
import { asOptionalJsonRecord } from "../../messages/parseJsonRecord";
import { asTrimmedString } from "../../../core/trimmedString";
import type { Message, ToolPayload } from "../../messages/types";

/**
 * 工具参数里可能携带引用 dbKey 的字段名。
 * 收敛到 fetchReferenceContents 能消费的 page/dialog/table 三类，
 * 字段名来自 noloWorkspaceTools 的工具参数定义（readDoc/readAgent/readTable/...）。
 */
const REFERENCE_ARG_FIELDS = [
    "pageKey",
    "dialogKey",
    "dbKey",
    "docKey",
    "key",
    "id",
    "rowDbKey",
    "tableKey",
    "table",
] as const;

/**
 * 判断一个字符串是否是可被 fetchReferenceContents 成功加载的引用 key。
 * page / dialog record / table meta 三类；其余类型（agent/space/file/...）
 * 会被 fetchReferenceContents 读出后落到 fetchSlateReference 返回 null，无意义。
 */
export const isLoadableReferenceKey = (key: string): boolean =>
    isPageKey(key) || isDialogRecordKey(key) || isTableMetaKey(key);

/**
 * 从 tool 调用参数对象里提取引用 dbKey。
 * 扫描已知字段名，只保留 isLoadableReferenceKey 通过的值。
 */
const extractKeysFromArgs = (
    args: Record<string, unknown> | undefined,
    out: Set<string>,
): void => {
    if (!args) return;
    for (const field of REFERENCE_ARG_FIELDS) {
        const value = args[field];
        const key = asTrimmedString(value);
        if (key && isLoadableReferenceKey(key)) {
            out.add(key);
        }
    }
};

/**
 * 从 assistant 消息的 tool_calls 里提取引用 key。
 * tool_calls[].function.arguments 是 JSON string，解析后按已知字段名扫描。
 */
const extractKeysFromToolCalls = (msg: Message, out: Set<string>): void => {
    const toolCalls = msg.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const call of toolCalls) {
        const fn = call.function;
        const argumentsText = asTrimmedString(fn.arguments);
        if (!argumentsText) continue;
        const parsed = asOptionalJsonRecord(argumentsText);
        if (parsed) extractKeysFromArgs(parsed, out);
    }
};

/**
 * 从 tool result 消息的 toolPayload 里提取引用 key。
 * 优先 toolPayload.input，回退 toolPayload.rawToolCall.function.arguments。
 * 与 toolDisplayName.extractToolCallArgs 同构，但内联以避免 actions 层依赖 web 层。
 */
const extractKeysFromToolPayload = (
    toolPayload: ToolPayload | undefined,
    out: Set<string>,
): void => {
    if (!toolPayload) return;

    if (isRecord(toolPayload.input)) {
        extractKeysFromArgs(
            toolPayload.input as Record<string, unknown>,
            out,
        );
        return;
    }

    const rawToolCall = toolPayload.rawToolCall;
    if (isRecord(rawToolCall)) {
        const fn = rawToolCall.function;
        if (isRecord(fn)) {
            const argumentsText = asTrimmedString(fn.arguments);
            if (argumentsText) {
                const parsed = asOptionalJsonRecord(argumentsText);
                if (parsed) extractKeysFromArgs(parsed, out);
            }
        }
    }
};

/**
 * 从消息 content（array 或 object）提取 pageKey / dialogKey。
 * content 运行时可能携带 pageKey/dialogKey（见 pendingAttachmentParts），但
 * MessageContentPart 类型未声明这些字段，因此按 unknown + isRecord 窄化读取。
 */
const extractKeysFromContent = (msg: Message, out: Set<string>): void => {
    const content = msg.content;
    if (!content) return;

    const parts: unknown[] = Array.isArray(content) ? content : [content];
    for (const part of parts) {
        if (!isRecord(part)) continue;
        const pageKey = asTrimmedString(part.pageKey);
        if (pageKey) out.add(pageKey);
        const dialogKey = asTrimmedString(part.dialogKey);
        if (dialogKey) out.add(dialogKey);
    }
};

/**
 * 从一条消息里提取所有可加载的引用 dbKey。
 * 覆盖 content / tool_calls / toolPayload 三个来源。
 *
 * 用于：
 *   - updateDialogSummaryAction 压缩时把被裁消息的引用存进 referenceKeys
 *   - getFullChatContextKeys 实时扫描未压缩消息
 */
export const extractReferenceKeysFromMessage = (msg: Message): string[] => {
    const keys = new Set<string>();
    extractKeysFromContent(msg, keys);
    extractKeysFromToolCalls(msg, keys);
    extractKeysFromToolPayload(msg.toolPayload, keys);
    return Array.from(keys);
};