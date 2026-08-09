export const queryMemoryFunctionSchema = {
  name: "queryMemory",
  description: [
    "按需查询当前用户、Space 和当前 auto/fixed 助手主体的长期记忆。",
    "对话开始前系统会自动载入少量高相关记忆；只有预载不足、用户提到过去约定/偏好/纠正/未完成事项时才调用。",
    "不要为了普通事实问题查询，也不要在同一轮用近义词反复查询。",
    "",
    "【召回规则】召回的记忆必须带完整历史上下文（来源、置信度、变更记录），禁止自行推理填补。",
    "如果记忆来源是 inferred（推断），必须明确标注存疑，不能当成验证过的事实使用。",
    "高置信度记忆（verified/stated）优先使用；低置信度记忆（inferred）需验证后再采纳。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "要从长期记忆中检索的自然语言问题或关键词。",
      },
    },
    required: ["query"],
  } as const,
};
