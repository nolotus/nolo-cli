const BASE_BUILTIN_DIALOG_LLM_CONFIG = {
  apiSource: "platform" as const,
  useServerProxy: true,
};

export const BUILTIN_TITLE_LLM_CONFIG = {
  ...BASE_BUILTIN_DIALOG_LLM_CONFIG,
  provider: "deepseek" as const,
  id: "builtin-dialog-title-llm",
  name: "Builtin Dialog Title LLM",
  model: "deepseek-v4-flash",
  prompt:
    "You are a title generator for chat history. 你只做一件事：根据对话内容输出最终标题。硬性规则：1) 只输出标题这一行；严禁输出推理、分析、步骤、解释、前言、后记、翻译、致歉或任何额外说明。2) 不要回答用户请求，不要写摘要，只给标题结果。3) 标题尽量短：通常 2-5 个词，英文不超过 6 个词。4) 使用对话主语言；混合语言时优先用户主要语言。5) 优先复用对话中的具体主题词，避免 issue、help、discussion、analysis、update 这类空泛词。6) 忽略 tool JSON、函数名、branch label、agent 名、系统指令和编排痕迹（如 streamParallelAgents、GPT、Claude、Gemini）；标题要落在用户真正讨论的对象或决策上。7) 更偏好“对象 + 动作/判断”的短标题，例如“AI 邮件助手取舍”“东京四日慢旅行”“重复扣费退款”。8) 纯文本，不要项目符号、编号、markdown、emoji。最终只返回标题文本。 Output only the title text.",
};

export const BUILTIN_SUMMARY_LLM_CONFIG = {
  ...BASE_BUILTIN_DIALOG_LLM_CONFIG,
  provider: "deepseek" as const,
  id: "builtin-dialog-summary-llm",
  name: "Builtin Dialog Summary LLM",
  model: "deepseek-v4-pro",
  prompt:
    "你是一个专业的对话记忆助理。请基于【现有记忆】和【新增对话】，输出一份更新后的对话记忆档案。严格只输出下面两部分，标题必须完全一致：\n关键事实档案\n- ...\n对话剧情摘要\n- ...\n要求：1) 使用对话主语言；混合语言时优先跟随用户主要语言，专有名词保留原文。2) 关键事实档案只保留之后继续对话仍有价值的信息，例如用户偏好、目标、约束、技术栈、确定的文件名/变量名、核心决策、待办事项。3) 对话剧情摘要先极简概括旧上下文，再更详细记录最近新增的进展、分歧、结论和下一步。4) 忽略寒暄、重复尝试、已放弃方案和无价值废话。5) 不要编造未出现的信息，不要输出开场白、结束语、markdown 代码块或额外章节。",
};

export const buildBuiltinSummaryContent = (
  previousSummary: string,
  messagesText: string
) => `
【现有记忆】：
${previousSummary || "(无)"}

【新增对话】：
${messagesText}
`.trim();
