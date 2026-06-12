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
        "- 如果当前对话只需要一个简单的选择，而不需要额外解释，你也可以不输出额外的 content，而只调用本工具，由 question 字段直接向用户提问。"
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            question: {
                type: "string",
                description:
                    "展示给用户的问题文案，用一句话说明要做什么选择。例如：“接下来你更希望我帮你做哪件事？”。不要在同一轮 assistant 普通文本里重复这句话。"
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
            blocking: {
                type: "boolean",
                description: [
                    "是否需要等待用户选择之后，再继续当前流程（例如 Plan）。",
                    "默认 true：即发出问题后，等待用户点击某个选项再继续。"
                ].join(" "),
                default: true
            }
        },
        required: ["question", "choices"]
    }
};
export async function uiAskChoiceFunc(
    args: any,
    _thunkApi: AppThunkApi
): Promise<{
    rawData: {
        type: "ui_ask_choice";
        question: string;
        choices: any[];
        blocking: boolean;
    };
    displayData: string;
}> {
    const question = String(args?.question ?? "").trim();
    const choices = Array.isArray(args?.choices) ? args.choices : [];
    const blocking = args?.blocking !== false;

    if (!question || choices.length === 0) {
        throw new Error("ui_ask_choice 需要 question 和至少一个 choice。");
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