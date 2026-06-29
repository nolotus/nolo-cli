// src/app/i18n/translations/seo.locale.ts
import { Language } from "../../i18n/types";

const seoLocale: Record<
  Language,
  {
    title: string;
    description: string;
    home: {
      title: string;
      description: string;
    };
    pricing: {
      title: string;
      description: string;
    };
    explore: {
      title: string;
      description: string;
    };
    shareCommunity: {
      title: string;
      description: string;
    };
  }
> = {
  [Language.EN]: {
    title: "Nolo.Chat | Not Just a Chatbot — Your Private AI Team",
    description:
      "While others chat, Nolo.Chat works. Orchestrate multiple AI agents that remember your rules, collaborate on complex tasks, and keep running overnight — delivering real results by morning.",
    home: {
      title: "Nolo.Chat | AI that Remembers You and Gets the Work Done",
      description:
        "Work with GPT, Claude, DeepSeek and more in one AI workspace. Nolo remembers your context, lets multiple agents debate and collaborate, and turns ideas into docs, images, apps, and deliverables.",
    },
    pricing: {
      title: "Pricing | Pay for What You Use with Nolo Credits",
      description:
        "Start free, then top up credits only when you need more. Compare model costs, understand how credits work, and unlock advanced features without being locked into a subscription.",
    },
    explore: {
      title: "AI Plaza | Explore Public AI Agents on Nolo.Chat",
      description:
        "Browse public AI agents, compare their specialties, and discover real workflows built by the Nolo community before starting your own workspace.",
    },
    shareCommunity: {
      title: "Community Shares | See What People Build with Nolo.Chat",
      description:
        "Explore public chats, docs, apps, and shared outputs from the Nolo community to see how people use AI agents for real work.",
    },
  },
  [Language.ZH_CN]: {
    title: "Nolo.Chat | 让 Nolo 认识你，记住你，和你一起创造",
    description:
      "别人是一个 AI 帮你聊，我们是多个 Agent 帮你做完。记住你的规则、多模型协作、夜间自动执行——今晚委托，明早交付网页、图片、文档。",
    home: {
      title: "Nolo.Chat | 让 Nolo 认识你，记住你，和你一起创造",
      description:
        "把 GPT、Claude、DeepSeek 放进同一个 AI 工作台。Nolo 能记住你的上下文，让多个 Agent 协作或辩论，并直接产出文档、图片、网页和可交付结果。",
    },
    pricing: {
      title: "Nolo 定价 | 用多少，付多少",
      description:
        "注册即可免费开始，按实际模型消耗扣积分。查看积分规则、模型价格对比，以及如何在不订阅的情况下随时充值、随时使用。",
    },
    explore: {
      title: "Nolo AI 广场 | 发现公开 AI 与现成工作流",
      description:
        "在 AI 广场浏览公开 AI、查看它们擅长的任务与真实能力，再决定要不要把它加入你的工作流。",
    },
    shareCommunity: {
      title: "Nolo 社区分享 | 看别人怎样用 AI 把事做完",
      description:
        "浏览社区公开分享的对话、文档、应用与成果，了解真实用户如何用 Nolo 完成研究、写作、开发与自动化任务。",
    },
  },
  [Language.ZH_HANT]: {
    title: "Nolo.Chat | 讓 Nolo 認識你，記住你，和你一起創造",
    description:
      "別人是一個 AI 幫你聊，我們是多個 Agent 幫你做完。記住你的規則、多模型協作、夜間自動執行——今晚委託，明早交付網頁、圖片、文件。",
    home: {
      title: "Nolo.Chat | 讓 Nolo 認識你，記住你，和你一起創造",
      description:
        "把 GPT、Claude、DeepSeek 放進同一個 AI 工作台。Nolo 能記住你的上下文，讓多個 Agent 協作或辯論，並直接產出文件、圖片、網頁和可交付結果。",
    },
    pricing: {
      title: "Nolo 定價 | 用多少，付多少",
      description:
        "註冊即可免費開始，按實際模型消耗扣積分。查看積分規則、模型價格對比，以及如何在不訂閱的情況下隨時儲值、隨時使用。",
    },
    explore: {
      title: "Nolo AI 廣場 | 發現公開 AI 與現成工作流",
      description:
        "在 AI 廣場瀏覽公開 AI、查看它們擅長的任務與真實能力，再決定要不要把它加入你的工作流。",
    },
    shareCommunity: {
      title: "Nolo 社群分享 | 看別人如何用 AI 把事做完",
      description:
        "瀏覽社群公開分享的對話、文件、應用與成果，了解真實使用者如何用 Nolo 完成研究、寫作、開發與自動化任務。",
    },
  },
  [Language.JA]: {
    title: "Nolo.Chat | チャットを超えた、あなた専属の AI チーム",
    description:
      "他社が「一対一の会話」なら、Nolo.Chat は「複数 Agent が協力して仕事を完遂」。ルールを記憶し、夜間も自動実行。朝には成果物が届きます。",
    home: {
      title: "Nolo.Chat | 文脈を覚えて、仕事を仕上げる AI ワークスペース",
      description:
        "GPT、Claude、DeepSeek などを 1 つの AI ワークスペースで活用。Nolo は文脈を覚え、複数 Agent の協調や議論を通じて、文書・画像・Web・成果物まで形にします。",
    },
    pricing: {
      title: "Nolo 料金 | 使った分だけ支払うクレジット制",
      description:
        "無料ではじめて、必要な時だけクレジットを追加。モデルごとの消費量、クレジットの仕組み、サブスクなしで上位機能を使う方法を確認できます。",
    },
    explore: {
      title: "AI Plaza | Nolo.Chat の公開 AI を探す",
      description:
        "公開 AI エージェントを一覧で見比べ、それぞれの得意分野や実際の使い道を確認してから自分のワークフローに取り込めます。",
    },
    shareCommunity: {
      title: "コミュニティ共有 | Nolo.Chat で作られた実例を見る",
      description:
        "コミュニティが公開した対話、文書、アプリ、成果物を見ながら、Nolo が実務でどう使われているかを確認できます。",
    },
  },
};

export default seoLocale;
