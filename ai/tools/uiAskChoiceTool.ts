// 文件: ai/tools/uiAskChoiceTool.ts

export const uiAskChoiceFunctionSchema = {
    name: "ask_user",
    description: "让用户在 2～5 个互斥选项之间做选择的通用“出选项”工具（需求模糊、分支决策、问卷等）。调用前须先在普通回复文本里解释背景与权衡（先解释，再调用）。多问题传 questions，单问题传 question+choices。",
    parameters: {
        type: "object",
        properties: {
            question: {
                type: "string",
                description:
                    "展示给用户的问题文案（单问题模式）。与 questions 二选一。"
            },
            choices: {
                type: "array",
                description:
                    "备选项列表，渲染为按钮供用户点击。",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description: "选项标识。"
                        },
                        label: {
                            type: "string",
                            description: "按钮文字，如“生成本周周报”。"
                        },
                        detail: {
                            type: "string",
                            description:
                                "简短补充（建议一句话），长解释写进调用前的回复文本。"
                        },
                        recommended: {
                            type: "boolean",
                            description:
                                "标记为推荐项（放首位并置 true，无推荐则省略）。"
                        },
                        userMessage: {
                            type: "string",
                            description:
                                "点击后作为下一条 user 消息发送的文案（留空默认用 label）。"
                        }
                    },
                    required: ["id", "label"]
                }
            },
            questions: {
                type: "array",
                description:
                    "多问题模式（多 tab 渲染，与 question+choices 二选一）。",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description: "问题标识。"
                        },
                        question: {
                            type: "string",
                            description: "问题文案。"
                        },
                        choices: {
                            type: "array",
                            description: "该问题的备选项。",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    label: { type: "string" },
                                    detail: {
                                        type: "string",
                                        description: "简短补充（建议一句话），长解释写进调用前的回复文本。"
                                    },
                                    recommended: {
                                        type: "boolean",
                                        description: "推荐项标记（置 true 标推荐，无则省略）。"
                                    },
                                    userMessage: { type: "string" }
                                },
                                required: ["id", "label"]
                            }
                        },
                        multiSelect: {
                            type: "boolean",
                            description: "允许多选，默认 false。"
                        },
                        allowOther: {
                            type: "boolean",
                            description: "显示“其他”自由输入行，默认 true。"
                        },
                        required: {
                            type: "boolean",
                            description: "是否必须回答才能提交，默认 true。"
                        }
                    },
                    required: ["id", "question", "choices"]
                }
            },
            blocking: {
                type: "boolean",
                description: "是否等待用户选择后再继续流程，默认 true。"
            }
        },
        required: []
    }
};
export async function uiAskChoiceFunc(
    args: any,
    _thunkApi: any
): Promise<{
    rawData: {
        type: "ask_user";
        question: string;
        choices: any[];
        blocking: boolean;
        questions?: any[];
    };
    displayData: string;
}> {
    const blocking = args?.blocking !== false;

    // New multi-question format
    if (Array.isArray(args?.questions) && args.questions.length > 0) {
        const firstQ = args.questions[0];
        return {
            rawData: {
                type: "ask_user",
                question: firstQ?.question ?? "",
                choices: firstQ?.choices ?? [],
                blocking,
                questions: args.questions,
            },
            displayData: args.questions.map((q: any) => q.question).join(" / "),
        };
    }

    // Legacy single-question format
    const question = String(args?.question ?? "").trim();
    const choices = Array.isArray(args?.choices) ? args.choices : [];

    if (!question || choices.length === 0) {
        throw new Error("ask_user 需要 question+choices 或 questions。");
    }

    return {
        rawData: {
            type: "ask_user",
            question,
            choices,
            blocking,
        },
        displayData: question,
    };
}

// ============================================================================
// Shared ask_user payload contract — single source of truth.
// Consumed by: the executor above, the CLI local executor, the CLI tool-output
// renderer, and the server saveDialog choice-selection lookup. Any change to
// the wire shape (type / question / choices / blocking / selected / cancelled)
// lands here so all readers stay in sync.
// ============================================================================

export type UiAskChoiceOption = {
    id?: string;
    label: string;
    detail?: string;
    /** 推荐标记：有明确推荐时置 true，并建议把该选项放在第一位。 */
    recommended?: boolean;
    userMessage?: string;
};

export type UiAskChoiceQuestionPayload = {
    id: string;
    question: string;
    choices: UiAskChoiceOption[];
    multiSelect?: boolean;
    allowOther?: boolean;
    required?: boolean;
};

export type UiAskChoicePayload = {
    type: "ask_user";
    question: string;
    choices: UiAskChoiceOption[];
    blocking: boolean;
    /** Multi-question mode: present when the LLM sent a questions array. */
    questions?: UiAskChoiceQuestionPayload[];
    /** Present when the tool was resolved interactively (CLI select dialog). */
    selected?: {
        label: string;
        userMessage: string;
    };
    /** Multi-question resolved result. */
    answers?: Array<{
        questionId: string;
        selectedIds: string[];
        otherText: string;
        userMessage: string;
    }>;
    /** Present when the user dismissed the select dialog without choosing. */
    cancelled?: boolean;
    /** Server-side error marker (mirrors the executor's error shape). */
    error?: string;
    detail?: string;
};

/**
 * Parse a raw tool result into a typed UiAskChoicePayload, or null when the
 * content is not a ask_user payload. Accepts both a JSON string (the wire
 * format stored on tool messages) and an already-parsed object.
 *
 * Does NOT trim/filter — callers validate question/choices for their own
 * display needs. Returns the parsed object as-is so readers that need raw
 * fields (selected/cancelled/error) get them.
 */
export function parseUiAskChoiceContent(
    rawContent: unknown,
): UiAskChoicePayload | null {
    const parsed =
        typeof rawContent === "string"
            ? (() => {
                  try {
                      return JSON.parse(rawContent);
                  } catch {
                      return null;
                  }
              })()
            : rawContent;
    if (!parsed || typeof parsed !== "object") return null;
    if ((parsed as any).type !== "ask_user") return null;
    return parsed as UiAskChoicePayload;
}