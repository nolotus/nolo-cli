/**
 * 能力分级定义 (Capability Tiers)
 */
export const TOOL_PACKS = {
  // L1 - 核心：交互 + 记忆读写 + 自我更新，所有 Agent 必有
  CORE: ["ui_ask_choice", "rememberMemory", "read", "searchDialogMessages", "createDoc", "updateDoc", "search_workspace", "search_all_spaces", "updateSelf", "queryModelUsage", "queryUserGrowthReport", "createAgentAutomation", "notifyUser"],
  // L2 - 联网搜索：配置了 web-capable tools 的 Agent 默认加，纯 QA bot 不加
  LIGHT_WEB: ["exa_search", "read_x_post", "read_xhs_profile"],
  // L3 - 深度浏览器：全套复杂网页交互
  FULL_BROWSER: [
    "browser_openSession",
    "browser_closeSession",
    "browser_click",
    "browser_typeText",
    "browser_readContent",
    "browser_selectOption",
    "fetchWebpage",
  ],
} as const;
