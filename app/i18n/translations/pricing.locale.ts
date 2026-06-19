import { Language } from "../types";

export default {
  [Language.EN]: {
    translation: {
      pricing: {
        title: "Pay-As-You-Go",
        subtitle: "Billed by actual token usage. Points never expire.\nPro unlocks at 19 points. No subscription lock-in.",
        free: "Free",
        points: "{{num}} Points",
        tiers: {
          starter: {
            name: "Starter",
            meta: "Free upon Signup",
            price: "Free",
            features: [
              "Standard LLM models",
              "Multi-agent collaboration",
              "Single file analysis",
              "Permanent chat history"
            ]
          },
          pro: {
            name: "Pro",
            meta: "Balance at 19 Points",
            price: "Unlock at 19 Points",
            features: [
              "Batch file analysis",
              "Real-time web search",
              "Priority processing queue",
              "Google Scholar Academic Search"
            ]
          },
          advanced: {
            name: "Advanced",
            meta: "Balance ≥ 199 / 999 Points",
            price: "Unlock with ≥ 199 / 999 Points",
            features: [
              "Advanced reasoning models",
              "Claude Opus access",
              "Dedicated VM runtime",
              "Isolated compute resources",
              "Long-running workload execution"
            ]
          }
        },
        cta: {
          titleLoggedIn: "Flexible Recharge",
          titleLoggedOut: "Try Free",
          descLoggedIn: "Points are credited instantly. Pro unlocks at 19 points, Advanced at 199 / 999 points.",
          descLoggedOut: "Sign up and start with the free tier before recharging.",
          btnRecharge: "Recharge Points",
          btnFreeStart: "Start Free",
          btnDirectRecharge: "Recharge Directly",
          trustLoggedIn: "Refundable anytime • Billed by usage • Never expires",
          trustLoggedOut: "No credit card • Instant access • No subscription lock-in"
        },
        searchPlaceholder: "Search models by name...",
        recommend: "Recommended",
        unknown: "Unknown",
        comparisonTitle: "Model Price Comparison (Points)",
        noModelsFound: "No matching models found",
        visionYes: "Yes",
        visionNo: "No",
        tableHeader: {
          name: "Model Name",
          input: "Input / 1M Points",
          output: "Output / 1M Points",
          vision: "Vision"
        },
        faqTitle: "Frequently Asked Questions",
        faqSubtitle: "Have questions? Check here first",
        faq: [
          {
            q: "What are points?",
            a: "Points are Nolo's usage unit. Every model call deducts points based on actual token consumption, so costs stay tied to real usage."
          },
          {
            q: "How do I recharge?",
            a: "Choose any amount on the recharge page. Points are credited immediately and are not tied to any subscription package."
          },
          {
            q: "Do points expire?",
            a: "No. Recharged points stay valid permanently."
          },
          {
            q: "Is it more cost-effective than subscriptions?",
            a: "Usually yes. Nolo charges at actual API cost with no subscription premium, so you only pay for real usage."
          }
        ]
      }
    }
  },
  [Language.ZH_CN]: {
    translation: {
      pricing: {
        title: "按量付费",
        subtitle: "按实际消耗的 Token 扣费，积分永久有效。\n余额达到 19 自动解锁专业版，无订阅绑定，随时降档。",
        free: "免费",
        points: "{{num}} 积分",
        tiers: {
          starter: {
            name: "基础版",
            meta: "注册即可使用",
            price: "免费",
            features: [
              "标准 LLM 模型",
              "多 Agent 协作",
              "单文件分析",
              "对话历史保存"
            ]
          },
          pro: {
            name: "专业版",
            meta: "余额达到 19 积分",
            price: "余额满 19 积分解锁",
            features: [
              "批量文件分析",
              "实时联网搜索",
              "优先处理队列",
              "Google Scholar 学术检索"
            ]
          },
          advanced: {
            name: "高阶版",
            meta: "余额保持 ≥ 199 / 999 积分",
            price: "余额 ≥ 199 / 999 积分解锁",
            features: [
              "GPT Pro 系列模型",
              "Claude Opus 模型",
              "独立虚拟机执行环境",
              "隔离的计算资源",
              "支持长时间超重任务"
            ]
          }
        },
        cta: {
          titleLoggedIn: "灵活充值",
          titleLoggedOut: "免费体验",
          descLoggedIn: "充值积分即时到账。余额达到 19 解锁专业版，达到 199 / 999 解锁高阶版。",
          descLoggedOut: "注册即可体验免费额度，先试再决定是否充值。",
          btnRecharge: "充值积分",
          btnFreeStart: "免费开始",
          btnDirectRecharge: "直接充值",
          trustLoggedIn: "支持退款 • 按量扣费 • 永久有效",
          trustLoggedOut: "无需信用卡 • 注册即用 • 无订阅绑定"
        },
        searchPlaceholder: "按模型名搜索...",
        recommend: "推荐",
        unknown: "未知",
        comparisonTitle: "模型价格对比（积分）",
        noModelsFound: "未找到匹配的模型",
        visionYes: "支持",
        visionNo: "不支持",
        tableHeader: {
          name: "模型名称",
          input: "输入 / 1M 积分",
          output: "输出 / 1M 积分",
          vision: "视觉识别"
        },
        searchBoxPlaceholder: "按模型名搜索...",
        faqTitle: "常见问题",
        faqSubtitle: "有疑问？先看这里",
        faq: [
          {
            q: "积分是什么？",
            a: "积分是 Nolo 的使用量单位。每次调用 AI 模型时，按实际消耗的 Token 数扣除对应积分。不同模型消耗速率不同，可按需切换，自主掌控支出。"
          },
          {
            q: "怎么充值？",
            a: "在充值页面选择任意金额即可，积分实时到账，不绑定任何套餐。"
          },
          {
            q: "积分会过期吗？",
            a: "不会。充值的积分长期有效，永不过期。"
          },
          {
            q: "比包月订阅更划算吗？",
            a: "通常更划算。Nolo 按实际 API 成本透明计费，没有订阅溢价，只为实际消耗付费。"
          }
        ]
      }
    }
  },
  [Language.ZH_HANT]: {
    translation: {
      pricing: {
        title: "按量付費",
        subtitle: "按實際消耗的 Token 扣費，積分永久有效。\n餘額達到 19 自動解鎖專業版，無訂閱綁定，隨時降檔。",
        free: "免費",
        points: "{{num}} 積分",
        tiers: {
          starter: {
            name: "基礎版",
            meta: "註冊即可使用",
            price: "免費",
            features: [
              "標準 LLM 模型",
              "多 Agent 協作",
              "單檔案分析",
              "對話歷史保存"
            ]
          },
          pro: {
            name: "專業版",
            meta: "餘額達到 19 積分",
            price: "餘額滿 19 積分解鎖",
            features: [
              "批次檔案分析",
              "即時聯網搜尋",
              "優先處理佇列",
              "Google Scholar 學術檢索"
            ]
          },
          advanced: {
            name: "高階版",
            meta: "餘額保持 ≥ 199 / 999 積分",
            price: "餘額 ≥ 199 / 999 積分解鎖",
            features: [
              "GPT Pro 系列模型",
              "Claude Opus 模型",
              "獨立虛擬機執行環境",
              "隔離的計算資源",
              "支援長時間超重任務"
            ]
          }
        },
        cta: {
          titleLoggedIn: "靈活充值",
          titleLoggedOut: "免費體驗",
          descLoggedIn: "充值積分即時到帳。餘額達到 19 解鎖專業版，達到 199 / 999 解鎖高階版。",
          descLoggedOut: "註冊即可體驗免費額度，先試再決定是否充值。",
          btnRecharge: "充值積分",
          btnFreeStart: "免費開始",
          btnDirectRecharge: "直接充值",
          trustLoggedIn: "支援退款 • 按量扣費 • 永久有效",
          trustLoggedOut: "無需信用卡 • 註冊即用 • 無訂閱綁定"
        },
        searchPlaceholder: "按模型名搜尋...",
        recommend: "推薦",
        unknown: "未知",
        comparisonTitle: "模型價格對比（積分）",
        noModelsFound: "未找到匹配的模型",
        visionYes: "支援",
        visionNo: "不支援",
        tableHeader: {
          name: "模型名稱",
          input: "輸入 / 1M 積分",
          output: "輸出 / 1M 積分",
          vision: "視覺識別"
        },
        faqTitle: "常見問題",
        faqSubtitle: "有疑問？先看這裡",
        faq: [
          {
            q: "積分是什麼？",
            a: "積分是 Nolo 的使用量單位。每次調用 AI 模型時，按實際消耗的 Token 數扣除對應積分。不同模型消耗速率不同，可按需切換，自主掌控支出。"
          },
          {
            q: "怎麼充值？",
            a: "在充值頁面選擇任意金額即可，積分即時到帳，不綁定任何套餐。"
          },
          {
            q: "積分會過期嗎？",
            a: "不會。充值的積分長期有效，永不過期。"
          },
          {
            q: "比包月訂閱更划算嗎？",
            a: "通常更划算。Nolo 按實際 API 成本透明計費，沒有訂閱溢價，只為實際消耗付費。"
          }
        ]
      }
    }
  },
  [Language.JA]: {
    translation: {
      pricing: {
        title: "従量課金制",
        subtitle: "実際のトークン消費量に基づいてポイントを減算。ポイントの有効期限はありません。\n残高が19ポイントに達すると自動的にプロ版がアンロックされます。いつでもダウングレード可能で、定期購入の縛りはありません。",
        free: "無料",
        points: "{{num}} ポイント",
        tiers: {
          starter: {
            name: "スターター",
            meta: "登録ですぐに使用可能",
            price: "無料",
            features: [
              "標準的なLLMモデル",
              "マルチエージェント協調",
              "単一ファイル分析",
              "チャット履歴の保存"
            ]
          },
          pro: {
            name: "プロ",
            meta: "残高19ポイント到達",
            price: "19ポイントでアンロック",
            features: [
              "複数ファイル分析",
              "リアルタイムWeb検索",
              "優先処理キュー",
              "Google Scholar 学術検索"
            ]
          },
          advanced: {
            name: "アドバンスド",
            meta: "残高199 / 999ポイント以上を維持",
            price: "199 / 999ポイントでアンロック",
            features: [
              "GPT Pro 系列モデル",
              "Claude Opus へのアクセス",
              "独立した仮想マシン実行環境",
              "隔離された計算リソース",
              "長時間・高負荷タスクの実行"
            ]
          }
        },
        cta: {
          titleLoggedIn: "フレキシブルなチャージ",
          titleLoggedOut: "無料体験",
          descLoggedIn: "チャージ後、ポイントは即座に反映されます。19ポイントでプロ版、199 / 999ポイントでアドバンスドがアンロックされます。",
          descLoggedOut: "登録後すぐに無料枠を体験できます。",
          btnRecharge: "ポイントをチャージ",
          btnFreeStart: "無料で開始",
          btnDirectRecharge: "直接チャージ",
          trustLoggedIn: "返金可能 • 従量課金 • 有効期限なし",
          trustLoggedOut: "クレジットカード不要 • 登録だけで開始 • 定期購入の縛りなし"
        },
        searchPlaceholder: "モデル名で検索...",
        recommend: "オススメ",
        unknown: "不明",
        comparisonTitle: "モデル価格比較（ポイント）",
        noModelsFound: "該当するモデルが見つかりません",
        visionYes: "対応",
        visionNo: "非対応",
        tableHeader: {
          name: "モデル名",
          input: "入力 / 1M ポイント",
          output: "出力 / 1M ポイント",
          vision: "ビジョン認識"
        },
        faqTitle: "よくある質問",
        faqSubtitle: "ご質問がありますか？ まずはこちらをご確認ください",
        faq: [
          {
            q: "ポイントとは何ですか？",
            a: "ポイントは Nolo の使用量単位です。AI モデルを呼び出すたびに、実際に消費されたトークン数に基づいて差し引かれます。"
          },
          {
            q: "チャージ方法は？",
            a: "チャージページで任意の金額を選択するだけで、ポイントが即座に反映されます。特定のパッケージには縛られません。"
          },
          {
            q: "ポイントに有効期限はありますか？",
            a: "いいえ。チャージされたポイントは長期的に有効で、期限はありません。"
          },
          {
            q: "月額サブスクリプションよりお得ですか？",
            a: "通常はお得です。Nolo は実際の API コストに基づいて透明性の高い課金を行い、実際の消費分だけを支払います。"
          }
        ]
      }
    }
  }
};
