export type CliLocale = "zh" | "en";

const ZH_PATTERNS = /^zh/i;

type EnvLike = Record<string, string | undefined>;

export function parseCliLocale(raw: string | undefined): CliLocale | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return null;
  if (ZH_PATTERNS.test(normalized)) return "zh";
  if (normalized === "en" || normalized.startsWith("en")) return "en";
  return null;
}

function detectLocaleFromEnv(env: EnvLike): CliLocale | null {
  // Explicit override first: profile config surfaces the saved /lang choice
  // through NOLO_LANG, and users can also export it directly.
  const explicit = parseCliLocale(env.NOLO_LANG);
  if (explicit) return explicit;
  const candidates = [env.LC_ALL, env.LC_CTYPE, env.LANG].filter(Boolean);
  for (const candidate of candidates) {
    if (ZH_PATTERNS.test(candidate!)) return "zh";
    if (candidate && !candidate.startsWith("C.") && !candidate.startsWith("POSIX")) {
      return "en";
    }
  }
  return null;
}

function detectLocale(env: EnvLike): CliLocale {
  return detectLocaleFromEnv(env) ?? "zh";
}

let currentLocale: CliLocale = detectLocale(process.env);

export function getCliLocale(): CliLocale {
  return currentLocale;
}

export function setCliLocale(locale: CliLocale) {
  currentLocale = locale;
}

/**
 * Re-detect the locale from a specific env (the TUI passes its merged
 * profile+process env, which module-load detection cannot see).
 */
export function initCliLocale(env: EnvLike = process.env) {
  currentLocale = detectLocale(env);
}

const STRINGS = {
  welcomeHint: {
    en: "Tell nolo what you want. Use /help for commands. Shift+Enter for newline.",
    zh: "告诉 nolo 你想要什么。输入 /help 查看命令。Shift+Enter 换行。",
  },
  promptLabel: {
    en: "❯ ",
    zh: "❯ ",
  },
  continueLabel: {
    en: "│ ",
    zh: "│ ",
  },
  placeholder: {
    en: "Type a message or / for commands...",
    zh: "输入消息，或用 / 查看命令…",
  },
  newDialog: {
    en: "new dialog",
    zh: "新对话",
  },
  startedFreshDialog: {
    en: "Started a fresh dialog.",
    zh: "已开始新对话。",
  },
  bye: {
    en: "Bye.",
    zh: "再见。",
  },
  resumedDialogPrefix: {
    en: "Resumed dialog",
    zh: "已恢复对话",
  },
  resumeInvalidId: {
    en: "does not look like a dialog id. Use /history to pick one.",
    zh: "看起来不是 dialog id。用 /history 从列表里选一个。",
  },
  dialogResumeCancelled: {
    en: "Dialog resume cancelled.",
    zh: "已取消恢复对话。",
  },
  agentSwitchCancelled: {
    en: "Agent switch cancelled.",
    zh: "已取消切换 agent。",
  },
  historyPickerTitle: {
    en: "Resume dialog (↑↓ Enter Esc)",
    zh: "恢复对话（↑↓ 移动 · Enter 选择 · Esc 取消）",
  },
  noDialogsYet: {
    en: "No dialogs yet.",
    zh: "还没有历史对话。",
  },
  langUsage: {
    en: "Usage: /lang <zh|en>",
    zh: "用法：/lang <zh|en>",
  },
  stopHint: {
    en: "Esc to stop",
    zh: "Esc 停止回复",
  },
  turnStopped: {
    en: "Stopped this reply.",
    zh: "已停止本次回复。",
  },
  copiedLastReply: {
    en: "Copied the last reply to the clipboard.",
    zh: "已复制最后一条回复到剪贴板。",
  },
  copyNothing: {
    en: "Nothing to copy yet.",
    zh: "还没有可复制的内容。",
  },
  copyFailed: {
    en: "Copy failed",
    zh: "复制失败",
  },
  copyUnavailable: {
    en: "Clipboard is unavailable in this environment. The last reply was printed above for manual copy.",
    zh: "当前环境没有可用的剪贴板。最后一条回复已打印在上方，可手动复制。",
  },
  copyUsage: {
    en: "Usage: /copy or /copy view",
    zh: "用法：/copy 或 /copy view",
  },
  copyViewTitle: {
    en: "Copy view — latest AI reply",
    zh: "复制视图 — 最新 AI 回复",
  },
  copyViewHint: {
    en: "Drag to select; edge scrolling uses native terminal scrollback. Press Esc or Enter to return.",
    zh: "直接拖选，拖到边缘可用终端原生回滚跨屏选择。按 Esc 或 Enter 返回。",
  },
  historyNoToken: {
    en: "History requires an auth token. Run `nolo login` or set AUTH_TOKEN.",
    zh: "查看历史对话需要登录凭证。请运行 `nolo login` 或设置 AUTH_TOKEN。",
  },
  historyBadToken: {
    en: "Could not read a user id from AUTH_TOKEN. Run `nolo login` again.",
    zh: "无法从 AUTH_TOKEN 解析出用户 id，请重新运行 `nolo login`。",
  },
  mouseOn: {
    en: "Mouse mode on: wheel scrolls the transcript; hold Shift (or Option/Fn) to select text.",
    zh: "鼠标模式已开启：滚轮滚动对话记录；按住 Shift（或 Option/Fn）可拖选复制。",
  },
  mouseOff: {
    en: "Mouse mode off: drag to select/copy freely; scroll with PageUp/PageDown.",
    zh: "鼠标模式已关闭：可直接拖选复制；用 PageUp/PageDown 滚动对话记录。",
  },
  mouseUsage: {
    en: "Usage: /mouse <on|off>",
    zh: "用法：/mouse <on|off>",
  },
  langSwitched: {
    en: "Language switched to English.",
    zh: "已切换为中文。",
  },
  // --- Tool trace copy ------------------------------------------------------
  // The compact trace shows only status, never timing or output size: a line
  // count told the user nothing actionable and the ms figure read as noise.
  toolNeedsAction: {
    en: "needs action",
    zh: "待确认",
  },
  toolTimedOut: {
    en: "timed out",
    zh: "已超时",
  },
  toolExitCode: {
    en: "exit",
    zh: "退出码",
  },
  toolFailed: {
    en: "failed",
    zh: "失败",
  },
  // --- Dialog (picker / confirm) copy --------------------------------------
  // Key-hint wording is unified across select / multi-select / confirm so the
  // three dialogs read as one family: "<Label>  <↑↓ move · Enter choose ·
  // Esc cancel>  <count>". Connectors are "·" between keys, two spaces between
  // the label, hint, and count. zh uses full-width parentheses to match the
  // existing historyPickerTitle; en uses ASCII parentheses.
  dialogSelectLabel: {
    en: "Select",
    zh: "选择",
  },
  dialogSelectHint: {
    en: "(↑↓ move · Enter choose · Esc cancel)",
    zh: "（↑↓ 移动 · Enter 选择 · Esc 取消）",
  },
  dialogMultiSelectLabel: {
    en: "Select",
    zh: "选择",
  },
  dialogMultiSelectHint: {
    en: "(↑↓ move · Space toggle · Enter submit · Esc cancel)",
    zh: "（↑↓ 移动 · Space 切换 · Enter 提交 · Esc 取消）",
  },
  dialogMultiSelectSelected: {
    en: "selected",
    zh: "已选",
  },
  dialogConfirmHint: {
    en: "(↑↓ move · Enter choose · Esc cancel)",
    zh: "（↑↓ 移动 · Enter 选择 · Esc 取消）",
  },
  dialogConfirmTitle: {
    en: "Confirm destructive shell command",
    zh: "确认执行破坏性 shell 命令",
  },
  dialogConfirmBody: {
    en: "This command may delete or reset user content and needs explicit confirmation before it runs.",
    zh: "该命令可能删除或重置用户内容，需要用户明确确认后才能执行。",
  },
  dialogConfirmCommandLabel: {
    en: "Command",
    zh: "命令",
  },
  dialogConfirmCommandTruncated: {
    en: "(truncated)",
    zh: "（已截断）",
  },
  dialogConfirmAllowLabel: {
    en: "Allow",
    zh: "允许",
  },
  dialogConfirmAllowDetail: {
    en: "execute this time",
    zh: "本次执行",
  },
  dialogConfirmCancelLabel: {
    en: "Cancel",
    zh: "取消",
  },
  dialogConfirmCancelDetail: {
    en: "abort the operation",
    zh: "中止操作",
  },
  helpText: {
    en: [
      "Commands:",
      "  /help                 Show this help",
      "  /new                  Clear screen and start a fresh dialog",
      "  /compact              Compact current dialog and fork a new one",
      "  /context              Show workspace context and next actions",
      "  /runtime <mode>       Use auto, local, or server runtime",
      "  /tools <mode>         Control tool trace: hide, compact, verbose",
      "  /thinking <mode>      Control thinking output: hide, marker, show",
      "  /render <mode>        Control assistant output: plain, rich",
      "  /agent                Pick an agent interactively (↑↓, Enter)",
      "  /agent list           List agents as text",
      "  /agent <name>         Switch directly by name, alias, or key",
      "  /agents               List platform agent shortcuts",
      "  /switch <agent>       Switch the current agent (alias of /agent <name>)",
      "  /history              Pick a recent dialog to resume (↑↓, Enter)",
      "  /resume <dialogId>    Resume a dialog directly by id",
      "  /lang <zh|en>         Switch interface language",
      "  /copy                 Copy the last reply to the clipboard",
      "  /copy view            Open native scrollback for partial selection (Ctrl+O)",
      "  /mouse <on|off>       Toggle mouse mode (off = drag to select text)",
      "  /doc                  List attached docs",
      "  /doc attach <doc>     Attach a doc to this workspace",
      "  /customize            Describe how you want to tune nolo",
      "  /login                Show login/profile hint",
      "  /profile              Show active profile",
      "  /update               Update the nolo CLI install",
      "  /version              Show version/update hint",
      "  /exit                 Leave the workspace",
      "",
      "You can also type normally. nolo routes simple read/status requests to CLI commands and sends the rest to the current agent.",
    ].join("\n"),
    zh: [
      "命令：",
      "  /help                 显示本帮助",
      "  /new                  清屏并开始新对话",
      "  /compact              压缩当前对话并分叉出新对话",
      "  /context              查看工作区上下文与后续操作",
      "  /runtime <mode>       切换 runtime：auto、local、server",
      "  /tools <mode>         工具轨迹显示：hide、compact、verbose",
      "  /thinking <mode>      思考过程显示：hide、marker、show",
      "  /render <mode>        回复渲染方式：plain、rich",
      "  /agent                交互式选择 agent（↑↓ 移动，Enter 确认）",
      "  /agent list           以文本列出全部 agent",
      "  /agent <name>         按名称、别名或 key 直接切换",
      "  /agents               列出平台 agent 快捷方式",
      "  /switch <agent>       切换当前 agent（等同 /agent <name>）",
      "  /history              从最近对话中选择并恢复（↑↓，Enter）",
      "  /resume <dialogId>    按 id 直接恢复对话",
      "  /lang <zh|en>         切换界面语言",
      "  /copy                 复制最后一条回复到剪贴板",
      "  /copy view            打开原生回滚进行跨屏拖选（Ctrl+O）",
      "  /mouse <on|off>       切换鼠标模式（off 后可直接拖选文本）",
      "  /doc                  列出已挂载的文档",
      "  /doc attach <doc>     挂载文档到当前工作区",
      "  /customize            描述你想怎么调教 nolo",
      "  /login                查看登录 / 配置提示",
      "  /profile              查看当前配置环境",
      "  /update               更新 nolo CLI",
      "  /version              查看版本与更新提示",
      "  /exit                 退出工作区",
      "",
      "也可以直接输入自然语言。简单的读取/状态请求会走 CLI 命令，其余交给当前 agent。",
    ].join("\n"),
  },
} as const;

export type CliStringKey = keyof typeof STRINGS;

export function t(key: CliStringKey): string {
  return STRINGS[key][currentLocale];
}

/**
 * Human-readable tool labels for the compact tool trace.
 *
 * The trace reads as a running narration of what nolo is doing ("读取
 * packages/cli/x.ts"), so labels are action verbs rather than the raw tool
 * identifier. Only the tools a workspace user actually sees are listed —
 * anything else falls back to the raw name, which keeps the platform tool
 * registry (packages/ai/tools/index.ts, 100+ entries) out of this file.
 */
const TOOL_LABELS: Record<string, { en: string; zh: string }> = {
  // Local workspace tools (packages/agent-runtime/localWorkspaceTools.ts)
  readFile: { en: "Read", zh: "读取" },
  writeFile: { en: "Write", zh: "写入" },
  editFile: { en: "Edit", zh: "编辑" },
  listFiles: { en: "List", zh: "列出" },
  searchFiles: { en: "Search", zh: "搜索" },
  globFiles: { en: "Glob", zh: "匹配" },
  execShell: { en: "Run", zh: "执行" },
  runCommand: { en: "Run", zh: "执行" },
  captureVisualState: { en: "Capture", zh: "截屏" },
  // Workspace / diagnostics
  searchWorkspace: { en: "Search workspace", zh: "搜索工作区" },
  cliDoctor: { en: "Doctor", zh: "自检" },
  cliWhoami: { en: "Whoami", zh: "查看身份" },
  checkEnv: { en: "Check env", zh: "检查环境" },
  configure: { en: "Configure", zh: "配置" },
  notifyUser: { en: "Notify", zh: "通知" },
  // Docs / dialogs / spaces
  readDoc: { en: "Read doc", zh: "读取文档" },
  createDoc: { en: "Create doc", zh: "新建文档" },
  updateDoc: { en: "Update doc", zh: "更新文档" },
  readDialog: { en: "Read dialog", zh: "读取对话" },
  listDialogs: { en: "List dialogs", zh: "列出对话" },
  queryDialogsBySubjectRef: { en: "Query dialogs", zh: "查询对话" },
  searchDialogMessages: { en: "Search messages", zh: "搜索消息" },
  listSpaces: { en: "List spaces", zh: "列出空间" },
  readSpace: { en: "Read space", zh: "读取空间" },
  // Tables
  createTable: { en: "Create table", zh: "创建表" },
  queryTableRows: { en: "Query rows", zh: "查询表行" },
  addTableRow: { en: "Add row", zh: "新增表行" },
  addTableRows: { en: "Add rows", zh: "新增表行" },
  updateTableRow: { en: "Update row", zh: "更新表行" },
  deleteTableRow: { en: "Delete row", zh: "删除表行" },
  // Web
  fetchWebpage: { en: "Fetch page", zh: "抓取网页" },
  readPage: { en: "Read page", zh: "读取网页" },
  exaSearch: { en: "Web search", zh: "联网搜索" },
};

/** Localized action label for a tool, falling back to the raw tool name. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name]?.[currentLocale] ?? name;
}
