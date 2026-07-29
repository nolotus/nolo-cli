// 文件路径: ai/agent/types.ts

import type { QuickChatModelOverride } from "./quickChatModelOverride";

export interface AgentRuntimeOptions {
    /**
     * 在本次调用中额外开放给 LLM 的工具名称。
     * 会与 Agent 本身的 tools 数组合并后再传给 LLM。
     * 名字要和 toolRegistry 中的 schema.name 对齐，例如 "addTableRow"。
     */
    extraTools?: string[];

    /**
     * 当前调用关注的“编辑目标”，用于后续构造 editingContext。
     * 这里只定义接口，不涉及任何持久化或具体实现。
     */
    editingTarget?: {
        /**
         * 语义标签，比如: "table" | "page" | "article" | "code" 等。
         * 未来可以扩展，但不需要改 Prompt 结构。
         */
        kind: string;
        /**
         * 可选：具体对象的 key，例如表的 dbKey、页面的 pageKey。
         * 如果不传，后面可以从全局 state 中推断。
         */
        key?: string;
        /**
         * 可选：用于补充当前编辑对象的人类可读标题。
         * 适用于对象不在本地 Redux 中、但调用方已知元数据的场景。
         */
        title?: string;
        /**
         * 可选：调用方预构造的一段简短说明，供 prompt 构造时使用。
         */
        summary?: string;
        /**
         * 可选：与当前编辑目标相关的轻量元数据。
         * 例如应用的 framework、url、fileNames 等。
         */
        metadata?: Record<string, unknown>;
    };

    /**
     * 本轮调用的图片生成配置，仅作用于这一轮请求。
     * 会在调用前与 Agent / Dialog 的默认配置合并后传给 LLM。
     */
    imageConfigOverride?: {
        /** 是否在本轮启用图片输出（不写或 true 表示按默认；false 可强制关闭） */
        enabled?: boolean;
        /** 本轮强制切换到另一个图片模型变体，仅作用于本次调用 */
        imageModelOverride?: string;

        /** 本轮期望的宽高比，不指定则使用上层（Dialog / Agent / 模型）的默认值 */
        aspectRatio?:
        | "1:1"
        | "2:3"
        | "3:2"
        | "3:4"
        | "4:3"
        | "4:5"
        | "5:4"
        | "9:16"
        | "16:9"
        | "21:9";

        /** 本轮期望的分辨率大小，不指定则使用上层默认值 */
        imageSize?: "1K" | "2K" | "4K";
    };

    cwd?: string;
    restrictShellToWorkspace?: boolean;

    /**
     * quick-chat 通用档意图提示：本轮用户消息表达了文件/代码/工作区意图，
     * 桌面端 runtime 应为通用三档内置 agent 注入只读工作区工具集。
     * 仅对 quick-chat 通用档（BUILTIN_PLATFORM_AGENT_CONFIGS 的 key）生效；
     * 专职/用户自建 agent 完全忽略此 hint。
     */
    workspaceToolsHint?: boolean;

    /**
     * quick-chat 自动模式「模型层覆盖」：LLM 分类路由落到通用档
     * （flash/balanced/quality 内置档位 agent）时，用用户选择的收藏 agent
     * 的 model 层配置替换档位 agent 的 model 层，并把收藏 agent 的
     * references（技能/能力包）合并进本轮执行。档位 agent 的 prompt /
     * 工具策略保持不变；专职 agent、image 档与普通对话不使用此字段。
     */
    quickChatModelOverride?: QuickChatModelOverride | null;
}
