// 文件: ai/tools/uiAskChoiceTool.ts

export const uiAskChoiceFunctionSchema = {
    name: "ui_ask_choice",
    description: [
        "当你需要让用户在几个互斥的选项之间做选择时，使用本工具。",
        "",
        "这是一个通用的“出选项”工具，适用于多种场景，例如：",
        "1）用户的需求比较宽泛或模糊，你可以给出 2～5 个不同方向的候选方案，让 TA 先选一个方向；",
        "2）一个计划 / 流程到了分支节点，需要用户决定下一步做什么；",
        "3）你想为用户设计一组练习题、测试题或问卷题（如出题练习、人格测试等单选题）；",
        "4）在新阶段/新会话中，根据系统提示或用户画像，给出若干“接下来可以尝试的事情”（例如功能导航或使用技巧）。",
        "",
        "使用建议：",
        "- 当你判断“先给出 2～5 个明确选项能显著帮用户理清下一步要做什么”时，可以主动调用本工具；",
        "- 如果用户的目标已经非常具体、清晰，并且你可以直接给出高质量答案，优先直接回答，而不是再弹出选择菜单；",
        "- 默认情况下，不要在完全没有有效上下文的场景（例如用户只说“你好”）立刻调用本工具，除非系统提示中已经明确要求你在新会话开头用它来生成欢迎菜单或功能导航；",
        "- 请把给用户看的问题写在 question 字段中，不要在同一轮 assistant 普通文本里重复这句话；",
        "- 每个选项的 userMessage 建议写成完整的一句话，方便后续理解上下文；如果留空，将自动使用 label 作为 userMessage。",
        "",
        "在代码协作场景下的推荐用法：",
        "- 如果你已经在本轮 assistant 的 content 中给出了分析、说明或多个备选方案，可以在同一轮消息的结尾调用本工具，请用户选择“是否根据上述方案开始实际修改代码”或“优先执行哪一个方案/步骤”。",
        "- 在这种情况下，question 字段通常是一个简短的问题（例如：“接下来你希望我按哪个方案来具体修改代码？”），而详细的解释和方案描述放在 content 中。",
        "- 如果当前对话只需要一个简单的选择，而不需要额外解释，你也可以不输出额外的 content，而只调用本工具，由 question 字段直接向用户提问。",
        "",
        "多问题 & 多选支持：",
        "- 当你需要一次问多个问题时，使用 questions 数组代替 question+choices。",
        "- 每个 question 可以设置 multiSelect: true 允许多选。",
        "- 每个 question 可以设置 allowOther: false 隐藏\u201c其他\u201d输入框。",
        "- 每个 choice 可以加 detail 字段提供更长的描述。"
    ].join("\n"),
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
                    "备选项列表。每个选项会渲染成一个按钮，供用户点击选择。",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description:
                                "选项内部标识（用于后续逻辑或调试，不会直接展示给用户）。"
                        },
                        label: {
                            type: "string",
                            description:
                                "显示给用户看的按钮文字。例如：“生成本周周报”。"
                        },
                        detail: {
                            type: "string",
                            description:
                                "选项的补充描述，显示在 label 下方。可选。"
                        },
                        userMessage: {
                            type: "string",
                            description: [
                                "用户点击此选项后，你希望作为下一条 user 消息发送给模型的自然语言内容。",
                                "建议写成完整的一句话，例如：“帮我生成一份本周的工作周报”。",
                                "如果留空，将使用 label 作为 userMessage。"
                            ].join(" ")
                        }
                    },
                    required: ["id", "label"]
                }
            },
            questions: {
                type: "array",
                description:
                    "多问题模式：一次问多个问题，每个问题独立渲染为一个 tab。与 question+choices 二选一。",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description: "问题标识，用于结果对应。"
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
                                        description: "补充描述。"
                                    },
                                    userMessage: { type: "string" }
                                },
                                required: ["id", "label"]
                            }
                        },
                        multiSelect: {
                            type: "boolean",
                            description: "允许多选。默认 false。",
                            default: false
                        },
                        allowOther: {
                            type: "boolean",
                            description: "显示“其他”自由输入行。默认 true。",
                            default: true
                        },
                        required: {
                            type: "boolean",
                            description: "是否必须回答才能提交。默认 true。",
                            default: true
                        }
                    },
                    required: ["id", "question", "choices"]
                }
            },
            blocking: {
                type: "boolean",
                description: [
                    "是否需要等待用户选择之后，再继续当前流程（例如 Plan）。",
                    "默认 true：即发出问题后，等待用户点击某个选项再继续。"
                ].join(" "),
                default: true
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
        type: "ui_ask_choice";
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
                type: "ui_ask_choice",
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
        throw new Error("ui_ask_choice 需要 question+choices 或 questions。");
    }

    return {
        rawData: {
            type: "ui_ask_choice",
            question,
            choices,
            blocking,
        },
        displayData: question,
    };
}

// ============================================================================
// Shared ui_ask_choice payload contract — single source of truth.
// Consumed by: the executor above, the CLI local executor, the CLI tool-output
// renderer, and the server saveDialog choice-selection lookup. Any change to
// the wire shape (type / question / choices / blocking / selected / cancelled)
// lands here so all readers stay in sync.
// ============================================================================

export type UiAskChoiceOption = {
    id?: string;
    label: string;
    detail?: string;
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
    type: "ui_ask_choice";
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
 * content is not a ui_ask_choice payload. Accepts both a JSON string (the wire
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
    if ((parsed as any).type !== "ui_ask_choice") return null;
    return parsed as UiAskChoicePayload;
}