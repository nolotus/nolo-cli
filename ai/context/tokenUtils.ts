// ai/context/tokenUtils.ts

/**
 * 简单的 Token 估算工具。
 * 
 * 规则：
 * - 中文字符：约 1.5 tokens/字
 * - 英文及其他字符：约 0.25 tokens/字符（即 4 字符 ≈ 1 token）
 * 
 * 这是一个粗略估算，精确值需要使用 tiktoken 等库。
 */

/**
 * 估算文本的 Token 数量
 */
export const estimateTokenCount = (text: string): number => {
    if (!text) return 0;

    // 匹配中文字符（包括常用汉字范围）
    const chineseChars = (text.match(/[\u4e00-\u9fa5\u3400-\u4dbf]/g) || []).length;
    const otherChars = text.length - chineseChars;

    // 中文 1.5 token/字，其他 0.25 token/字符
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
};

/**
 * 估算多个文本的 Token 总数
 */
export const estimateTotalTokens = (texts: (string | undefined | null)[]): number => {
    return texts.reduce((sum, text) => sum + estimateTokenCount(text || ""), 0);
};

/**
 * 格式化 Token 数量为可读字符串
 * 例如：1500 -> "1.5k", 150000 -> "150k"
 */
export const formatTokenCount = (count: number): string => {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    return `${Math.round(count / 1000)}k`;
};

/**
 * 计算 Token 使用百分比
 */
export const calcTokenUsagePercent = (used: number, total: number): number => {
    if (total <= 0) return 0;
    return Math.min(100, Math.round((used / total) * 100));
};

/**
 * Context 分配建议阈值
 * - References/Space Context 不应超过总量的 40%
 * - 为对话历史和用户输入预留 40%
 * - 为系统提示预留 10%
 * - 为输出预留 10%
 */
export const CONTEXT_BUDGET = {
    REFERENCES_MAX_PERCENT: 40, // References + Space Context 最大占比
    HISTORY_RESERVE_PERCENT: 40, // 为对话历史预留
    SYSTEM_RESERVE_PERCENT: 10, // 系统提示预留
    OUTPUT_RESERVE_PERCENT: 10, // 输出预留
};

/**
 * 判断 Token 使用是否超过警告阈值
 */
export const isTokenUsageWarning = (usedPercent: number): boolean => {
    return usedPercent > CONTEXT_BUDGET.REFERENCES_MAX_PERCENT;
};

/**
 * 判断 Token 使用是否严重超标
 */
export const isTokenUsageCritical = (usedPercent: number): boolean => {
    return usedPercent > 60; // 超过 60% 可能影响对话历史
};
