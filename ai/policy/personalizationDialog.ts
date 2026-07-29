import { noloAgentId } from "../../core/init";
import { createDialog, initDialog } from "../../chat/dialog/dialogSlice";
import { buildDialogUrl } from "../../chat/dialog/dialogUrl";
import { prepareAndPersistMessage } from "../../chat/messages/messageSlice";
import {
  uiAskChoiceFunc,
  uiAskChoiceFunctionSchema,
} from "../tools/uiAskChoiceTool";
import type { AgentRuntimeOptions } from "../agent/types";

export type PersonalizationDialogSource = "signup" | "home";

/**
 * 当前阶段，这个入口只负责“对话式编辑 User Overlay Profile”。
 * 未来它可以演进成引导用户创建属于自己的一个或多个 AI，
 * 但那会把偏好采集和 agent 创建耦合在一起，所以现在明确不做。
 *
 * 这里刻意继续复用 nolo，而不是单独拆一个 personalization-agent、
 * 也不是把它建模成 skill / first-class mode：
 * - 用户感知上，这仍然是“nolo 帮我做个性化设置”，一致感比内部抽象更重要；
 * - 当前只有这一条特殊入口，单独引入 agent/skill/mode 只会把同一套约束换个名字再实现一遍；
 * - 真正变化的是这个 dialog 的目标、允许的工具和策略上下文，所以先用 dialog category 承载。
 *
 * 以后如果出现第二、第三个长期存在的“特殊流程对话”，再考虑把这类 category 升级成统一抽象。
 */
export const PERSONALIZATION_DIALOG_CATEGORY = "user-overlay-profile";
export const PERSONALIZATION_DIALOG_EXTRA_TOOLS = [
  "ui_ask_choice",
  "updateUserPreferenceProfile",
] as const;

type SupportedCopyLocale = "en" | "zh-CN" | "zh-TW" | "ja";

const resolveCopyLocale = (language?: string | null): SupportedCopyLocale => {
  const normalized = (language || "").toLowerCase();

  if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk")) {
    return "zh-TW";
  }

  if (normalized.startsWith("zh")) {
    return "zh-CN";
  }

  if (normalized.startsWith("ja")) {
    return "ja";
  }

  return "en";
};

export const buildPersonalizationDialogTitle = (
  language?: string | null,
  source: PersonalizationDialogSource = "home"
): string => {
  const locale = resolveCopyLocale(language);

  const titles = {
    en:
      source === "signup" ? "Set Up Your AI Preferences" : "Adjust AI Preferences",
    "zh-CN": source === "signup" ? "开始设置你的 AI 偏好" : "调整 AI 偏好",
    "zh-TW": source === "signup" ? "開始設定你的 AI 偏好" : "調整 AI 偏好",
    ja:
      source === "signup" ? "AI の好みを設定する" : "AI の好みを調整する",
  } as const;

  return titles[locale];
};

export const buildPersonalizationStarterPrompt = (
  language?: string | null,
  source: PersonalizationDialogSource = "home"
): string => {
  const locale = resolveCopyLocale(language);

  if (locale === "zh-CN") {
    return source === "signup"
      ? "我刚完成注册。请你作为我的个性化 AI 偏好助手，用最多 3 个简短问题帮我确认这三件事：1. 我偏好的交流语气；2. 值得沉淀的结果应该如何处理；3. 回答问题时是否应该读取当前空间，以及读取到什么程度。请保持简洁、像真正的对话，不要一次把所有选项都堆给我。在我确认之前，不要创建文档，不要修改或创建任何 AI。最后请把建议整理成明确设置项，方便我确认或调整。"
      : "我想通过对话调整我的 AI 偏好。请你作为个性化 AI 偏好助手，用最多 3 个简短问题帮我重新确认：1. 我偏好的交流语气；2. 值得沉淀的结果应该如何处理；3. 回答问题时是否应该读取当前空间，以及读取到什么程度。请保持简洁、像真正的对话。在我确认之前，不要创建文档，不要修改或创建任何 AI。最后请把建议整理成明确设置项，方便我确认或调整。";
  }

  if (locale === "zh-TW") {
    return source === "signup"
      ? "我剛完成註冊。請你作為我的個人化 AI 偏好助手，用最多 3 個簡短問題幫我確認這三件事：1. 我偏好的交流語氣；2. 值得沉澱的結果應該如何處理；3. 回答問題時是否應該讀取目前空間，以及讀取到什麼程度。請保持簡潔、像真正的對話，不要一次把所有選項都丟給我。在我確認之前，不要建立文件，不要修改或建立任何 AI。最後請把建議整理成明確設定項，方便我確認或調整。"
      : "我想透過對話調整我的 AI 偏好。請你作為個人化 AI 偏好助手，用最多 3 個簡短問題幫我重新確認：1. 我偏好的交流語氣；2. 值得沉澱的結果應該如何處理；3. 回答問題時是否應該讀取目前空間，以及讀取到什麼程度。請保持簡潔、像真正的對話。在我確認之前，不要建立文件，不要修改或建立任何 AI。最後請把建議整理成明確設定項，方便我確認或調整。";
  }

  if (locale === "ja") {
    return source === "signup"
      ? "登録したばかりです。あなたは私の AI 設定アシスタントとして、最大 3 つの短い質問で次の 3 点を確認してください。1. 好みの話し方 2. 価値のある結果をどのように知識化するか 3. 回答時に現在のスペースを読むべきか、どの程度読むか。長い説明ではなく自然な対話で進めてください。私が確認する前に、ドキュメントを作成したり、AI を作成・更新したりしないでください。最後に、確認しやすい設定項目として整理してください。"
      : "会話しながら AI の好みを調整したいです。あなたは設定アシスタントとして、最大 3 つの短い質問で次の 3 点を再確認してください。1. 好みの話し方 2. 価値のある結果をどのように知識化するか 3. 回答時に現在のスペースを読むべきか、どの程度読むか。自然な対話で簡潔に進めてください。私が確認する前に、ドキュメントを作成したり、AI を作成・更新したりしないでください。最後に、確認しやすい設定項目として整理してください。";
  }

  return source === "signup"
    ? "I just signed up. Act as my AI personalization assistant and use at most three short questions to confirm three things: 1. the tone I prefer, 2. how reusable results should be captured, and 3. whether you should read the current space when answering, and how aggressively. Keep it concise and conversational. Do not create documents, and do not create or modify any AI before I confirm. End by summarizing the recommended settings so I can confirm or adjust them."
    : "I want to adjust my AI preferences through conversation. Act as my AI personalization assistant and use at most three short questions to reconfirm three things: 1. the tone I prefer, 2. how reusable results should be captured, and 3. whether you should read the current space when answering, and how aggressively. Keep it concise and conversational. Do not create documents, and do not create or modify any AI before I confirm. End by summarizing the recommended settings so I can confirm or adjust them.";
};

export const buildPersonalizationRuntimeOptions = (
  runtimeOptions?: AgentRuntimeOptions
): AgentRuntimeOptions => ({
  ...runtimeOptions,
  extraTools: Array.from(
    new Set([
      ...(runtimeOptions?.extraTools ?? []),
      ...PERSONALIZATION_DIALOG_EXTRA_TOOLS,
    ])
  ),
});

export const buildPersonalizationDialogPolicyContext = (): string =>
  [
    "当前对话是“用户个性化设置”模式，不是普通闲聊。",
    "你的目标是用简短对话帮助用户确认 tone、knowledge_capture、space_context 这三项偏好。",
    "如果用户先介绍自己、工作方式或长期沟通偏好，请把这些可复用信息整理成简洁的 globalPrompt 草案，并在用户确认后通过 updateUserPreferenceProfile 保存。",
    "优先一次只问一个问题；当存在清晰互斥选项时，优先调用 ui_ask_choice。",
    "收集到足够信息后，调用 updateUserPreferenceProfile 保存结果，然后用自然语言总结已保存的设置。",
    "保存完成后，要提醒用户：以后也可以在设置里修改 globalPrompt 和这些偏好，或者再次打开这个入口继续调整。",
    "个性化设置完成后，可顺手引导用户尝试 1 到 2 个相关功能，例如首页快捷对话、创建笔记、创建 AI，但不要一次推荐太多。",
    "除非用户明确要求，否则不要创建文档，不要创建或修改任何 agent。",
  ].join("\n");

const buildPersonalizationOpeningChoice = (
  language?: string | null,
  source: PersonalizationDialogSource = "home"
) => {
  const locale = resolveCopyLocale(language);

  if (locale === "zh-CN") {
    return {
      question:
        source === "signup"
          ? [
              "你好，我会帮你完成 **AI 偏好设置确认**。",
              "",
              "你可以直接快速设置，也可以先做个自我介绍，我会顺手帮你整理成全局提示词。",
              "",
              "你想怎么开始？",
            ].join("\n")
          : [
              "我们来调整一下你的 **AI 偏好设置**。",
              "",
              "你可以直接快速设置，也可以先做个自我介绍，我会顺手帮你整理成全局提示词。",
              "",
              "你想怎么开始？",
            ].join("\n"),
      choices: [
        {
          id: "quick_setup",
          label: "直接快速设置",
          userMessage:
            "直接开始快速设置吧。请用最多三个简短问题帮我确定语气、知识沉淀和空间读取偏好。",
        },
        {
          id: "intro_first",
          label: "先做自我介绍",
          userMessage:
            "我想先做个自我介绍。请根据我的介绍帮我整理一段适合写进全局提示词的内容，在我确认后保存，然后继续完成语气、知识沉淀和空间读取设置。",
        },
        {
          id: "show_capabilities",
          label: "先看看你能做什么",
          userMessage:
            "先用很短的话告诉我 nolo 在这里还能帮我做什么，然后继续带我完成个性化设置。",
        },
      ],
    };
  }

  if (locale === "zh-TW") {
    return {
      question:
        source === "signup"
          ? [
              "你好，我會幫你完成 **AI 偏好設定確認**。",
              "",
              "你可以直接快速設定，也可以先做個自我介紹，我會順手幫你整理成全域提示詞。",
              "",
              "你想怎麼開始？",
            ].join("\n")
          : [
              "我們來調整一下你的 **AI 偏好設定**。",
              "",
              "你可以直接快速設定，也可以先做個自我介紹，我會順手幫你整理成全域提示詞。",
              "",
              "你想怎麼開始？",
            ].join("\n"),
      choices: [
        {
          id: "quick_setup",
          label: "直接快速設定",
          userMessage:
            "直接開始快速設定吧。請用最多三個簡短問題幫我確定語氣、知識沉澱與空間讀取偏好。",
        },
        {
          id: "intro_first",
          label: "先做自我介紹",
          userMessage:
            "我想先做個自我介紹。請根據我的介紹幫我整理一段適合寫進全域提示詞的內容，在我確認後保存，然後繼續完成語氣、知識沉澱與空間讀取設定。",
        },
        {
          id: "show_capabilities",
          label: "先看看你能做什麼",
          userMessage:
            "先用很短的話告訴我 nolo 在這裡還能幫我做什麼，然後繼續帶我完成個人化設定。",
        },
      ],
    };
  }

  if (locale === "ja") {
    return {
      question:
        source === "signup"
          ? "**AI の好み設定** を進めます。\n\nすぐに設定を始めることもできますし、先に自己紹介してもらえれば、その内容を global prompt にまとめられます。\n\nどう始めますか？"
          : "**AI の好み設定** を調整しましょう。\n\nすぐに設定を始めることもできますし、先に自己紹介してもらえれば、その内容を global prompt にまとめられます。\n\nどう始めますか？",
      choices: [
        {
          id: "quick_setup",
          label: "すぐに設定する",
          userMessage:
            "すぐに設定を始めたいです。最大3つの短い質問で、話し方、知識化、スペース読取の好みを確認してください。",
        },
        {
          id: "intro_first",
          label: "先に自己紹介する",
          userMessage:
            "先に自己紹介したいです。私の紹介をもとに global prompt に入れる短い文を作って、確認後に保存し、そのあと残りの設定も進めてください。",
        },
        {
          id: "show_capabilities",
          label: "何ができるか先に見る",
          userMessage:
            "先に nolo がここで何をしてくれるのかを短く教えてください。そのあと個人設定を続けてください。",
        },
      ],
    };
  }

  return {
    question:
      source === "signup"
        ? "Let's set up your **AI preferences**.\n\nWe can either start with a quick setup, or you can introduce yourself first and I'll turn that into a reusable global prompt.\n\nHow do you want to begin?"
        : "Let's adjust your **AI preferences**.\n\nWe can either start with a quick setup, or you can introduce yourself first and I'll turn that into a reusable global prompt.\n\nHow do you want to begin?",
    choices: [
      {
        id: "quick_setup",
        label: "Start quick setup",
        userMessage:
          "Start the quick setup. Ask me at most three short questions to confirm my tone, knowledge capture, and space-reading preferences.",
      },
      {
        id: "intro_first",
        label: "Let me introduce myself first",
        userMessage:
          "I want to introduce myself first. Please turn my introduction into a concise global prompt draft, save it after I confirm, and then continue the rest of the personalization setup.",
      },
      {
        id: "show_capabilities",
        label: "Show what nolo can do first",
        userMessage:
          "First, briefly show me what nolo can help me do here, then continue the personalization setup.",
      },
    ],
  };
};

export interface StartPersonalizationDialogParams {
  dispatch: any;
  navigate: (to: string, options?: { state?: Record<string, unknown> }) => void;
  language?: string | null;
  source?: PersonalizationDialogSource;
}

export const startPersonalizationDialog = async ({
  dispatch,
  navigate,
  language,
  source = "home",
}: StartPersonalizationDialogParams): Promise<string> => {
  const result = await dispatch(
    createDialog({
      cybots: [noloAgentId],
      skipGreeting: true,
      title: buildPersonalizationDialogTitle(language, source),
      category: PERSONALIZATION_DIALOG_CATEGORY,
    })
  ).unwrap();

  const dialogKey = (result as { dbKey?: string } | undefined)?.dbKey ?? "";
  const dialogSpaceId =
    (result as { spaceId?: string | null } | undefined)?.spaceId ?? null;

  if (!dialogKey) {
    throw new Error("Personalization dialog key is missing.");
  }

  await dispatch(initDialog(dialogKey)).unwrap();
  const openingChoice = buildPersonalizationOpeningChoice(language, source);
  const toolResult = await uiAskChoiceFunc(
    {
      question: openingChoice.question,
      choices: openingChoice.choices,
      blocking: true,
    },
    { dispatch }
  );

  await dispatch(
    (prepareAndPersistMessage as any)({
      message: {
        role: "tool",
        toolName: uiAskChoiceFunctionSchema.name,
        cybotKey: noloAgentId,
        content: toolResult.rawData as any,
        displayData: toolResult.displayData,
      },
      dialogConfig: {
        id: dialogKey.split("-").at(-1) ?? "",
        dbKey: dialogKey,
      },
    })
  );

  navigate(buildDialogUrl(dialogKey, dialogSpaceId), {
    state: {
      isNew: true,
      personalizationSource: source,
    },
  });

  return dialogKey;
};
