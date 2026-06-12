/**
 * 构建包含 system prompt 的完整 prompt。
 *
 * CLI agent 与普通 model 共用 prompt / model / 最近文本上下文这些能力面，
 * 但 CLI 不走本地 tool-calls 协议，因此这里只做文本级结构化拼接。
 */
export function buildCliPrompt(systemPrompt: string | undefined, taskPrompt: string): string {
  if (!systemPrompt?.trim()) return taskPrompt;
  return `[角色设定]\n${systemPrompt.trim()}\n\n[当前任务]\n${taskPrompt.trim()}`;
}
