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

/**
 * Windows terminals (conhost / Windows Terminal default mode) send the same
 * bare \r for Shift+Enter as for plain Enter, so the TUI cannot distinguish
 * the two. Ctrl+J (LF) is supported as newline on every platform/terminal.
 */
export function newlineHint(platform: string = process.platform): string {
  return platform === "win32" ? "Ctrl+J" : "Shift+Enter";
}

const STRINGS = {
  welcomeHint: {
    en: `Tell nolo what you want. Use /help for commands. ${newlineHint()} for newline.`,
    zh: `告诉 nolo 你想要什么。输入 /help 查看命令。${newlineHint()} 换行。`,
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
  clearingDialog: {
    en: "Clearing current dialog messages...",
    zh: "正在清除当前对话消息…",
  },
  clearedDialog: {
    en: "Cleared current dialog messages.",
    zh: "已清除当前对话消息。",
  },
  persistentProcessesLeft: {
    en: "{0} persistent process(es) left running in the background.",
    zh: "仍有 {0} 个常驻后台进程在后台继续运行。",
  },
  clearNoDialog: {
    en: "No current dialog messages to clear.",
    zh: "当前没有可清除的对话消息。",
  },
  clearUsage: {
    en: "Usage: /clear",
    zh: "用法：/clear",
  },
  contextNextClear: {
    en: "clear current dialog messages",
    zh: "清除当前对话消息",
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
  agentPickerLoading: {
    en: "Loading agents…",
    zh: "正在加载 agent 列表…",
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
  queuedHint: {
    en: "queued",
    zh: "排队",
  },
  flushQueuedIdleHint: {
    en: "Flushed {0} queued messages as one.",
    zh: "已把 {0} 条排队消息合并发送。",
  },
  flushQueuedBusyHint: {
    en: "Stopped this reply and flushed {0} queued messages as one.",
    zh: "已停止当前回复，并把 {0} 条排队消息合并发送。",
  },
  turnStopped: {
    en: "Stopped this reply.",
    zh: "已停止本次回复。",
  },
  turnStoppedToolPending: {
    en: "Stopped waiting. {0} may still be finishing in the background — its result won't be added to this conversation.",
    zh: "已停止等待。{0} 可能仍在后台完成，其结果不会计入本次对话。",
  },
  turnStopping: {
    en: "Stopping… press Esc again to force",
    zh: "正在停止…再按一次 Esc 强制停止",
  },
  forceStopped: {
    en: "Force stopped. Background tasks may still be finishing.",
    zh: "已强制停止，后台任务可能仍在收尾。",
  },
  turnFailed: {
    en: "This reply failed. Queued messages are kept — press Enter to resend.",
    zh: "本次回复出错。已排队的消息仍保留，按 Enter 可重新发送。",
  },
  quotaExhaustedHint: {
    en: "[nolo] This agent seems to have hit a quota/rate limit (HTTP 429).\nUse /agent to switch to another agent and keep going — the dialog context is preserved.",
    zh: "[nolo] 当前 agent 似乎额度/速率受限（429）。\n可以用 /agent 切换到其他 agent 后继续，同一对话会保留上下文。",
  },
  balanceExhaustedHint: {
    en: "[nolo] Insufficient balance. Your message is saved in this dialog — top up, then send again or say \"continue\".",
    zh: "[nolo] 余额不足。你刚发的话已保存在当前对话里——充值后直接再说一句或说「继续」即可，不会丢上下文。",
  },
  dialogPreservedHint: {
    en: "[nolo] This turn failed, but the dialog is kept. Send another message (or say \"continue\") to keep going in the same conversation.",
    zh: "[nolo] 本轮失败了，但对话已保留。直接再说一句（或说「继续」）即可在同一对话里接着聊。",
  },
  dialogNotSavedHint: {
    en: "[nolo] This turn did not create a dialog. Your next message will start a new conversation — restate what you need.",
    zh: "[nolo] 本轮没有建成对话。下一句会是新对话——请把你想做的事再说一遍。",
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
    en: "Usage: /copy",
    zh: "用法：/copy",
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
  altscreenOn: {
    en: "Alternate screen on: the TUI uses a private buffer so the terminal wheel no longer fights its own scroll state.",
    zh: "备用屏已开启：TUI 使用独立缓冲区，终端滚轮不再与自身滚动状态互相打架。",
  },
  altscreenOff: {
    en: "Alternate screen off: the TUI shares the shell scrollback (wheel may desync the viewport).",
    zh: "备用屏已关闭：TUI 与 shell 共用回滚缓冲区（滚轮可能让视口错位）。",
  },
  altscreenUsage: {
    en: "Usage: /altscreen <on|off>",
    zh: "用法：/altscreen <on|off>",
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
  usedSkillLabel: {
    en: "Used Skill",
    zh: "已加载技能",
  },
  // --- Agent-run orchestration cards (injected into packages/ai helpers) ---
  runStatusLabel: {
    en: "Run status",
    zh: "运行状态",
  },
  runStartedLabel: {
    en: "Run started",
    zh: "运行已启动",
  },
  runStoppedLabel: {
    en: "Run stopped",
    zh: "运行已停止",
  },
  runFinishedLabel: {
    en: "Run finished",
    zh: "运行已结束",
  },
  runLogTailLabel: {
    en: "Log tail:",
    zh: "日志尾部：",
  },
  runsListLabel: {
    en: "Runs ({0})",
    zh: "运行 ({0})",
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
  dialogMultiSelectRequired: {
    en: "Pick at least one option to submit",
    zh: "至少选择一项才能提交",
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
  dialogConfirmExternalFileTitle: {
    en: "Confirm reading a file outside the workspace",
    zh: "确认读取工作区外部文件",
  },
  dialogConfirmExternalFileBody: {
    en: "This path is outside the current workspace. Allow this one-time access, or deny it.",
    zh: "该路径位于当前工作区之外。确认后本次访问放行，否则拒绝。",
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
  // --- Ask choice (ask_user) ------------------------------------------
  askChoiceTitle: {
    en: "question",
    zh: "问题",
  },
  askChoiceSubmit: {
    en: "Submit",
    zh: "提交",
  },
  askChoiceOtherLabel: {
    en: "Other",
    zh: "其他",
  },
  askChoiceHintSingle: {
    en: "Type your answer, then press Enter to save.",
    zh: "输入回答后按 Enter 保存。",
  },
  askChoiceHintMulti: {
    en: "Space to toggle, Enter to confirm selection.",
    zh: "空格切换选中，Enter 确认提交。",
  },
  askChoiceFooterSingle: {
    en: "↵ pick/submit · tab switch · esc cancel",
    zh: "↵ 选择/提交 · tab 切换 · esc 取消",
  },
  askChoiceFooterMulti: {
    en: "↵ submit · space toggle · tab switch · esc cancel",
    zh: "↵ 提交 · space 切换 · tab 切换 · esc 取消",
  },
  askChoiceHistoryHint: {
    en: "Type a number to choose, or reply directly:",
    zh: "请输入序号选择，或直接回复：",
  },
  askChoiceHistorySelected: {
    en: "selected",
    zh: "已选",
  },
  askChoiceHistoryCancelled: {
    en: "cancelled",
    zh: "已取消",
  },
  contextTitle: {
    en: "Workspace context",
    zh: "工作区上下文",
  },
  contextNext: {
    en: "Next:",
    zh: "下一步：",
  },
  contextFieldAgent: {
    en: "agent",
    zh: "智能体",
  },
  contextFieldTokens: {
    en: "tokens",
    zh: "令牌",
  },
  contextFieldDialog: {
    en: "dialog",
    zh: "对话",
  },
  contextFieldDocs: {
    en: "docs",
    zh: "文档",
  },
  contextFieldSkills: {
    en: "skills",
    zh: "技能",
  },
  contextFieldProfile: {
    en: "profile",
    zh: "配置",
  },
  contextFieldRuntime: {
    en: "runtime",
    zh: "运行时",
  },
  contextFieldTools: {
    en: "tools",
    zh: "工具",
  },
  contextFieldServer: {
    en: "server",
    zh: "服务端",
  },
  contextNextAgents: {
    en: "see specialist shortcuts",
    zh: "查看专用智能体快捷方式",
  },
  contextNextDoc: {
    en: "add working context",
    zh: "添加工作上下文",
  },
  contextNextSkill: {
    en: "attach a skill to this workspace",
    zh: "为该工作区挂载技能",
  },
  contextNextNew: {
    en: "start a clean dialog",
    zh: "开始一个干净的对话",
  },
  agentsTitle: {
    en: "Agents:",
    zh: "智能体：",
  },
  agentsTip: {
    en: "Tip: run /switch for the full picker, or /switch list for your private agents too.",
    zh: "提示：用 /switch 打开完整选择器，或 /switch list 连你的私有智能体一起列出。",
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
      "  /switch               Pick an agent interactively (↑↓, Enter)",
      "  /switch list          List agents as text",
      "  /switch <name>        Switch directly by name, alias, or key (alias: /agent)",
      "  /agents               List platform agent shortcuts",
      "  /history              Pick a recent dialog to resume (↑↓, Enter)",
      "  /resume <dialogId>    Resume a dialog directly by id",
      "  /lang <zh|en>         Switch interface language",
      "  /copy                 Copy the last reply to the clipboard",
      "  /mouse <on|off>       Toggle mouse mode (off = drag to select text)",
      "  /altscreen <on|off>   Toggle the terminal alternate screen (default on; off shares shell scrollback)",
      "  /doc                  List attached docs",
      "  /doc attach <doc>     Attach a doc to this workspace",
      "  /skill                List attached skills",
      "  /skill attach <ref>   Attach a skill (dbKey, name, or SKILL.md path)",
      "  /skill detach <ref>   Detach a skill",
      "  /skill clear          Detach all skills",
      "  /customize            Describe how you want to tune nolo",
      "  /tasks                List background process tasks (aliases: /jobs, /procs)",
      "  /stop <pid|all>       Stop background process tasks",
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
      "  /switch               交互式选择 agent（↑↓ 移动，Enter 确认）",
      "  /switch list          以文本列出全部 agent",
      "  /switch <name>        按名称、别名或 key 直接切换（别名：/agent）",
      "  /agents               列出平台 agent 快捷方式",
      "  /history              从最近对话中选择并恢复（↑↓，Enter）",
      "  /resume <dialogId>    按 id 直接恢复对话",
      "  /lang <zh|en>         切换界面语言",
      "  /copy                 复制最后一条回复到剪贴板",
      "  /mouse <on|off>       切换鼠标模式（off 后可直接拖选文本）",
      "  /altscreen <on|off>   切换终端备用屏（默认 on；off 改为与 shell 共用回滚）",
      "  /doc                  列出已挂载的文档",
      "  /doc attach <doc>     挂载文档到当前工作区",
      "  /skill                列出已挂载的技能",
      "  /skill attach <ref>   挂载技能（dbKey、名称或 SKILL.md 路径）",
      "  /skill detach <ref>   卸载指定技能",
      "  /skill clear          卸载全部技能",
      "  /customize            描述你想怎么调教 nolo",
      "  /tasks                列出后台子进程任务（别名：/jobs, /procs）",
      "  /stop <pid|all>       停止指定的后台任务",
      "  /login                查看登录 / 配置提示",
      "  /profile              查看当前配置环境",
      "  /update               更新 nolo CLI",
      "  /version              查看版本与更新提示",
      "  /exit                 退出工作区",
      "",
      "也可以直接输入自然语言。简单的读取/状态请求会走 CLI 命令，其余交给当前 agent。",
    ].join("\n"),
  },
  // --- Slash-command output ---------------------------------------------
  // Command results that used to be hardcoded English. Usage lines keep the
  // command literal untouched; only the surrounding words are translated.
  unknownCommand: {
    en: "Unknown command: {0}\n\n",
    zh: "未知命令：{0}\n\n",
  },
  runtimeUsage: { en: "Usage: /runtime <auto|local|server>", zh: "用法：/runtime <auto|local|server>" },
  runtimeSet: { en: "Runtime: {0}", zh: "运行模式：{0}" },
  toolsCurrent: {
    en: "Tool display: {0} (hide | compact | verbose)",
    zh: "工具显示：{0}（hide | compact | verbose）",
  },
  toolsUsage: { en: "Usage: /tools <hide|compact|verbose>", zh: "用法：/tools <hide|compact|verbose>" },
  toolsSet: { en: "Tool display: {0}", zh: "工具显示：{0}" },
  tasksRunning: { en: "Running processes ({0}):", zh: "运行中的进程（{0}）：" },
  tasksStopped: { en: "Stopped/exited ({0}):", zh: "已停止/已退出（{0}）：" },
  tasksNone: { en: "No processes.", zh: "没有运行中的进程。" },
  stopUsage: { en: "Usage: /stop <pid|label|all>", zh: "用法：/stop <pid|label|all>" },
  stopAllDone: { en: "Stopped {0} processes", zh: "已停止 {0} 个进程" },
  stopNoPid: { en: "No running process with pid {0}", zh: "没有 pid 为 {0} 的运行中进程" },
  stopPidDone: { en: "Stopped pid {0} ({1})", zh: "已停止 pid {0}（{1}）" },
  stopNoLabel: { en: "No running process labeled '{0}'", zh: "没有名为“{0}”的运行中进程" },
  stopLabelsDone: { en: "Stopped {0}", zh: "已停止 {0}" },
  compactNothing: {
    en: "Current dialog: new (nothing to compact yet)",
    zh: "当前对话还是新的（还没有可压缩的内容）",
  },
  compactDone: {
    en: "Compacted dialog {0} → {1}.",
    zh: "已压缩对话 {0} → {1}。",
  },
  compactDoneNoSummary: {
    en: "Forked dialog {0} → {1} (no summary needed).",
    zh: "已分叉对话 {0} → {1}（无需压缩）。",
  },
  compactSuccess: {
    en: "✓ Compacted dialog {0} → {1} in {2}.",
    zh: "✓ 已压缩对话 {0} → {1}，耗时 {2}。",
  },
  compactSuccessWithCount: {
    en: "✓ Compacted dialog {0} → {1} in {2} ({3} messages compressed).",
    zh: "✓ 已压缩对话 {0} → {1}，耗时 {2}（压缩 {3} 条消息）。",
  },
  compactForked: {
    en: "✓ Forked dialog {0} → {1} in {2} (no summary needed).",
    zh: "✓ 已分叉对话 {0} → {1}，耗时 {2}（无需压缩）。",
  },
  agentCurrent: { en: "Current agent: {0} ({1})", zh: "当前 agent：{0}（{1}）" },
  agentPinnedUnaudited: {
    en: "No audit record for it — an older build wrote it; see agent-selection.log.",
    zh: "这条记录没有审计记录，是旧版本写的；详见 agent-selection.log。",
  },
  agentPinnedAuditRotated: {
    en: "The audit log has no entry for it — it aged out, or another session wrote it.",
    zh: "审计日志里没有它的记录——可能已被轮转，或是别的会话写的。",
  },
  agentPinnedFromProfile: {
    en: 'Agent "{0}" restored from {1} (saved selection). /switch nolo to go back to the default.',
    zh: "agent“{0}”来自 {1} 里保存的选择。/switch nolo 可切回默认档。",
  },
  agentUnknown: {
    en: "I don't know agent \"{0}\" yet.\nUse /switch, /switch list, /switch minimax-m3, or a full agent key.",
    zh: "还不认识 agent“{0}”。\n可以用 /switch、/switch list、/switch minimax-m3 或完整的 agent key 来切换。",
  },
  themeCurrent: { en: "Current theme: {0} · {1}", zh: "当前主题：{0} · {1}" },
  themeUsage: {
    en: "Usage: /theme <name> | /theme light | /theme dark | /theme refresh",
    zh: "用法：/theme <name> | /theme light | /theme dark | /theme refresh",
  },
  themeAvailable: { en: "Available themes: {0}", zh: "可用主题：{0}" },
  themeBrightnessSwitched: { en: "Switched to {0} background colors.", zh: "已切换到 {0} 背景色。" },
  themeBrightnessAuto: {
    en: "Background colors follow terminal detection (now: {0}).",
    zh: "背景色跟随终端自动检测（当前：{0}）。",
  },
  themeRefreshed: {
    en: "Re-detected terminal background: {0}.",
    zh: "已重新检测终端背景：{0}。",
  },
  themeRefreshFailed: {
    en: "Could not detect terminal background (not a TTY or no response).",
    zh: "无法检测终端背景（非 TTY 或终端无响应）。",
  },
  themeSwitched: { en: "Switched to theme: {0}", zh: "已切换到主题：{0}" },
  themeUnknown: { en: "Unknown theme: {0}. Available themes: {1}", zh: "未知主题：{0}。可用主题：{1}" },
  densityCurrent: {
    en: "Current density: {0}\nUsage: /density <cozy|spacious>",
    zh: "当前密度：{0}\n用法：/density <cozy|spacious>",
  },
  densitySwitched: { en: "Switched to layout density: {0}", zh: "已切换到布局密度：{0}" },
  densityUnknown: {
    en: "Unknown density: {0}. Use 'cozy' or 'spacious'.",
    zh: "未知密度：{0}。请使用 cozy 或 spacious。",
  },
  docAttachUsage: { en: "Usage: /doc attach <doc>", zh: "用法：/doc attach <doc>" },
  docList: { en: "Attached docs: {0}", zh: "已挂载文档：{0}" },
  docNone: { en: "No docs attached. Use /doc attach <doc>.", zh: "还没有挂载文档。用 /doc attach <doc> 挂载。" },
  skillAttachUsage: { en: "Usage: /skill attach <skill-ref>", zh: "用法：/skill attach <skill-ref>" },
  skillAttached: { en: "Attached skill: {0}", zh: "已挂载技能：{0}" },
  skillDetachUsage: { en: "Usage: /skill detach <skill-ref>", zh: "用法：/skill detach <skill-ref>" },
  skillDetached: { en: "Detached skill: {0}", zh: "已卸载技能：{0}" },
  skillNotAttached: { en: "Skill not attached: {0}", zh: "技能未挂载：{0}" },
  skillNone: { en: "No skills attached.", zh: "还没有挂载技能。" },
  skillCleared: { en: "Cleared {0} skill(s).", zh: "已清空 {0} 个技能。" },
  skillList: {
    en: "Attached skills: {0}\nUsage: /skill attach <ref> | /skill detach <ref> | /skill clear",
    zh: "已挂载技能：{0}\n用法：/skill attach <ref> | /skill detach <ref> | /skill clear",
  },
  skillNoneHint: {
    en: "No skills attached. Use /skill attach <skill-ref> to attach a skill.\nSkill refs can be a dbKey (page-xxx), a skill name (searched in .agents/skills/), or a direct path.",
    zh: "还没有挂载技能。用 /skill attach <skill-ref> 挂载技能。\n技能引用可以是 dbKey（page-xxx）、技能名（会在 .agents/skills/ 中查找）或直接路径。",
  },
  customizeHint: {
    en: "Tell nolo what to change, for example: /customize make my default agent more concise.",
    zh: "告诉 nolo 你想改什么，例如：/customize make my default agent more concise。",
  },
  loginHint: {
    en: "MVP login uses profile/env auth. Set AUTH_TOKEN, NOLO_SERVER, or NOLO_PROFILE before starting nolo.",
    zh: "MVP 登录走 profile/环境变量认证。启动 nolo 前请设置 AUTH_TOKEN、NOLO_SERVER 或 NOLO_PROFILE。",
  },
  versionInfo: {
    en: "nolo {0}\nUpdate this install with: nolo update\nIf repo-local output differs, publish/install the latest npm package first.",
    zh: "nolo {0}\n用 nolo update 更新当前安装。\n如果本地仓库输出的版本不同，请先发布/安装最新的 npm 包。",
  },
  versionUnknown: { en: "unknown version", zh: "未知版本" },
  updateAvailable: {
    en: "New nolo {0} available (you have {1}) — run /update to upgrade",
    zh: "新版本 nolo {0} 可用（当前 {1}）— 运行 /update 升级",
  },
  // --- Dialog list / timestamps -----------------------------------------
  recentDialogs: { en: "Recent dialogs:", zh: "最近对话：" },
  dialogListTip: {
    en: "Tip: run /history to pick one interactively, or paste an id after /resume.",
    zh: "提示：用 /history 交互式选择，或把 id 粘到 /resume 后面。",
  },
  timeJustNow: { en: "just now", zh: "刚刚" },
  timeMinutesAgo: { en: "{0}m ago", zh: "{0} 分钟前" },
  timeHoursAgo: { en: "{0}h ago", zh: "{0} 小时前" },
  timeDaysAgo: { en: "{0}d ago", zh: "{0} 天前" },
  // Overflow hints shared by select / multi-select / ask-choice. The arrows
  // and count are part of the copy so each locale can order them naturally.
  dialogMoreAbove: { en: "↑ {0} more", zh: "↑ {0} 更多" },
  dialogMoreBelow: { en: "↓ {0} more", zh: "↓ {0} 更多" },
  // Action gate handoff
  actionGateNeeded: {
    en: "Action needed in your terminal",
    zh: "终端需要你的操作",
  },
  actionGateEnterHint: {
    en: "Press Enter to run it now. Follow any prompts below, or Ctrl+C to cancel.",
    zh: "按 Enter 立即执行，按下方提示操作，或按 Ctrl+C 取消。",
  },
  actionGateInteractiveTitle: {
    en: "This command requires an interactive terminal.",
    zh: "该命令需要交互式终端",
  },
  actionGateInteractiveBody: {
    en: "Complete it in the terminal, then nolo will continue.",
    zh: "在终端中完成操作后，nolo 将继续。",
  },
  // Agent catalog sources
  agentSourcePlatform: {
    en: "Platform",
    zh: "平台",
  },
  agentSourceSubscription: {
    en: "Subscription",
    zh: "订阅",
  },
  agentSourceApi: {
    en: "API",
    zh: "API",
  },
} as const;

export type CliStringKey = keyof typeof STRINGS;

export function t(key: CliStringKey, ...params: string[]): string {
  const text = STRINGS[key][currentLocale];
  if (params.length === 0) return text;
  // Optional {0}/{1}/... interpolation; missing params keep the placeholder.
  return text.replace(/\{(\d+)\}/g, (match, index) => {
    const replacement = params[Number(index)];
    return replacement === undefined ? match : replacement;
  });
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
  // 同一工具在 web/server 工具面用 snake_case 命名（packages/ai/tools/index.ts）。
  search_workspace: { en: "Search workspace", zh: "搜索工作区" },
  // 全空间搜索：内置 skill search-all-spaces 声明的工作区工具，loadSkill 后进入
  // 工具面；同样需要中英文标签，避免回退成裸工具名。
  search_all_spaces: { en: "Search all spaces", zh: "搜索全部空间" },
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
  // Tree group header uses the same short category noun as Read/Search/Run
  // ("Fetch" / "抓取网页"), not a longer "Fetch page" phrase.
  fetchWebpage: { en: "Fetch", zh: "抓取网页" },
  readPage: { en: "Read page", zh: "读取网页" },
  exa_search: { en: "Web search", zh: "联网搜索" },
  // Skill loading
  loadSkill: { en: "Used Skill", zh: "使用技能" },
};

/** Localized action label for a tool, falling back to the raw tool name. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name]?.[currentLocale] ?? name;
}

/** Labels injected into `packages/ai` agent-run card helpers (no cli→ai reverse dep). */
export function agentRunCardLabels(): {
  runStatus: string;
  runStarted: string;
  runStopped: string;
  runFinished: string;
  logTail: string;
  runs: (count: number) => string;
} {
  return {
    runStatus: t("runStatusLabel"),
    runStarted: t("runStartedLabel"),
    runStopped: t("runStoppedLabel"),
    runFinished: t("runFinishedLabel"),
    logTail: t("runLogTailLabel"),
    runs: (count: number) => t("runsListLabel", String(count)),
  };
}
