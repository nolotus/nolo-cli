// src/app/i18n/translations/seo.locale.ts
import { Language } from "../../i18n/types";

export interface SeoLocaleEntry {
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
  about: {
    title: string;
    description: string;
  };
  contact: {
    title: string;
    description: string;
  };
}

const seoLocale: Record<Language, SeoLocaleEntry> = {
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
    about: {
      title: "About Nolo.Chat | Autonomous Multi-Agent Workspace & AI Platform",
      description:
        "Learn about Nolo.Chat's mission to transform how humans work with AI through local-first autonomous multi-agent orchestration, persistent memory, and multi-model collaboration.",
    },
    contact: {
      title: "Contact Us | Nolo.Chat Support, Feedback & Community",
      description:
        "Get in touch with the Nolo.Chat team for technical support, partnerships, bug reports, and feedback. Connect via email, community, and social channels.",
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
    about: {
      title: "关于 Nolo.Chat | 自主多 Agent 协作 AI 工作台",
      description:
        "了解 Nolo.Chat 的使命与技术愿景：通过本地优先架构、自主多 Agent 协作网络、持久长期记忆与多模型协同，打造真正替你把事做完的 AI 团队。",
    },
    contact: {
      title: "联系我们 | Nolo.Chat 官方支持与社区反馈",
      description:
        "获取 Nolo.Chat 官方技术支持、商务合作、问题反馈与社区交流入口。欢迎通过邮件与官方社区随时与我们联系。",
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
    about: {
      title: "關於 Nolo.Chat | 自主多 Agent 協作 AI 工作台",
      description:
        "了解 Nolo.Chat 的使命與技術願景：透過本地優先架構、自主多 Agent 協作網絡、持久長期記憶與多模型協同，打造真正替你把事做完的 AI 團隊。",
    },
    contact: {
      title: "聯絡我們 | Nolo.Chat 官方支援與社群反饋",
      description:
        "獲取 Nolo.Chat 官方技術支援、商務合作、問題反饋與社群交流入口。歡迎透過郵件與官方社群隨時與我們聯絡。",
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
    about: {
      title: "Nolo.Chat について | 自律型マルチエージェント AI ワークスペース",
      description:
        "Nolo.Chat のビジョンと技術：ローカルファースト設計、複数 Agent の自律協調、長期記憶、マルチモデル連携を通じて、仕事を実際に仕上げる AI チームを提供します。",
    },
    contact: {
      title: "お問い合わせ | Nolo.Chat 公式サポート＆コミュニティ",
      description:
        "Nolo.Chat の公式テクニカルサポート、提携、フィードバック窓口。メールや公式コミュニティからお気軽にお問い合わせください。",
    },
  },
  [Language.KO]: {
    title: "Nolo.Chat | 단순 챗봇을 넘어선 나만의 프라이빗 AI 팀",
    description:
      "단순한 대화를 넘어, 여러 AI 에이전트가 협력하여 업무를 완수합니다. 규칙을 기억하고 밤새 실행하여 아침에 실제 결과물을 제공합니다.",
    home: {
      title: "Nolo.Chat | 당신을 기억하고 업무를 완수하는 AI 워크스페이스",
      description:
        "GPT, Claude, DeepSeek 등을 하나의 AI 작업 공간에서 활용하세요. Nolo는 문맥을 기억하고, 여러 에이전트의 협업과 토론을 통해 문서, 이미지, 웹, 최종 결과물을 만듭니다.",
    },
    pricing: {
      title: "Nolo 요금제 | 사용한 만큼만 결제하는 크레딧 시스템",
      description:
        "무료로 시작하고 필요할 때만 크레딧을 충전하세요. 모델별 비용을 비교하고, 구독 없이 고급 기능을 유연하게 이용해 보세요.",
    },
    explore: {
      title: "AI 광장 | Nolo.Chat 공개 AI 에이전트 탐색",
      description:
        "공개된 AI 에이전트를 살펴보고, 각 분야의 전문성과 실제 워크플로를 확인한 뒤 나만의 작업 공간에 추가하세요.",
    },
    shareCommunity: {
      title: "커뮤니티 공유 | Nolo.Chat으로 완성된 실제 작업 사례",
      description:
        "Nolo 커뮤니티에서 공개 공유한 대화, 문서, 앱, 작업 결과물을 둘러보고 실제 업무에 AI를 활용하는 방법을 확인하세요.",
    },
    about: {
      title: "Nolo.Chat 소개 | 자율형 멀티 에이전트 AI 워크스페이스",
      description:
        "Nolo.Chat의 미션과 비전: 로컬 우선 아키텍처, 자율적인 멀티 에이전트 협업, 지속적인 장기 기억, 다중 모델 조율을 통해 실제 업무를 완수하는 AI 팀을 구축합니다.",
    },
    contact: {
      title: "문의하기 | Nolo.Chat 공식 지원 및 커뮤니티",
      description:
        "Nolo.Chat 기술 지원, 제휴, 피드백 및 커뮤니티 채널 안내. 이메일 및 공식 채널을 통해 언제든지 문의해 주세요.",
    },
  },
};

export default seoLocale;
