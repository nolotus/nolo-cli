export const CURRENT_OPERATOR_USER_ID = "0e95801d90";
export const NOLO_DEFAULT_AGENT_ID = "01NOLOAPPBLD000000019KCKT0";
export const NOLO_DEFAULT_AGENT_KEY = `agent-pub-${NOLO_DEFAULT_AGENT_ID}`;
export const NOLO_PROJECT_MANAGER_AGENT_ID = "01NOLOPROJMGR00000000MSVGG";
export const NOLO_PROJECT_MANAGER_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${NOLO_PROJECT_MANAGER_AGENT_ID}`;
export const NOLO_FRONTEND_AGENT_ID = "01FRONTENDAG0000000115N4E1";
export const NOLO_FRONTEND_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${NOLO_FRONTEND_AGENT_ID}`;
export const WIN_CODEX_AGENT_ID = "WINCODEX00000000FQ0LK0";
export const WIN_CODEX_AGENT_KEY =
  `agent-0e95801d90-${WIN_CODEX_AGENT_ID}`;
export const WIN_QWEN_AGENT_ID = "01CUSTOMCODEA00000001JEAG3";
export const WIN_QWEN_AGENT_KEY =
  `agent-0e95801d90-${WIN_QWEN_AGENT_ID}`;
export const MIMO_MONTH_AGENT_ID = "01MIMO25MONTH0000000NEW001";
export const MIMO_MONTH_AGENT_KEY =
  `agent-0e95801d90-${MIMO_MONTH_AGENT_ID}`;
export const QODER_AGENT_ID = "01QODERCLIAGENT00000000NEW";
export const QODER_AGENT_KEY =
  `agent-0e95801d90-${QODER_AGENT_ID}`;
export const LOCAL_CODEX_AGENT_ID = "01LOCALCODEXCLI000000NEW";
export const LOCAL_CODEX_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${LOCAL_CODEX_AGENT_ID}`;
export const LOCAL_QODER_AGENT_ID = "01LOCALQODERCLI000000NEW";
export const LOCAL_QODER_AGENT_KEY =
  `agent-${CURRENT_OPERATOR_USER_ID}-${LOCAL_QODER_AGENT_ID}`;

const AGENT_ALIAS_TO_KEY: Record<string, string> = {
  nolo: NOLO_DEFAULT_AGENT_KEY,
  default: NOLO_DEFAULT_AGENT_KEY,
  "default-nolo": NOLO_DEFAULT_AGENT_KEY,

  // Win Codex (高智力终审与架构把关)
  "win-codex": WIN_CODEX_AGENT_KEY,
  "wincodex": WIN_CODEX_AGENT_KEY,
  "win codex": WIN_CODEX_AGENT_KEY,
  "nolo-reviewer": WIN_CODEX_AGENT_KEY,
  reviewer: WIN_CODEX_AGENT_KEY,
  "nolo-code-review": WIN_CODEX_AGENT_KEY,
  "code-review": WIN_CODEX_AGENT_KEY,
  review: WIN_CODEX_AGENT_KEY,
  "代码审查": WIN_CODEX_AGENT_KEY,
  "nolo 代码审查": WIN_CODEX_AGENT_KEY,

  // 包月 Mimo (全栈业务代码与常规杂活物理实体)
  "包月mimo": MIMO_MONTH_AGENT_KEY,
  "包月mimo2.5": MIMO_MONTH_AGENT_KEY,
  "mimo-month": MIMO_MONTH_AGENT_KEY,
  "nolo-fullstack": MIMO_MONTH_AGENT_KEY,
  fullstack: MIMO_MONTH_AGENT_KEY,
  "full-stack": MIMO_MONTH_AGENT_KEY,
  "全栈": MIMO_MONTH_AGENT_KEY,
  "nolo 全栈工程师": MIMO_MONTH_AGENT_KEY,

  // Qoder CLI (本机 Qoder CLI 实现 agent)
  qoder: QODER_AGENT_KEY,
  "qoder-agent": QODER_AGENT_KEY,
  "qoder cli": QODER_AGENT_KEY,
  "qoder-cli": QODER_AGENT_KEY,

  // Explicit local CLI agents. These are ordinary private agent records that
  // run through the current computer local runtime when unbound.
  "local-codex": LOCAL_CODEX_AGENT_KEY,
  "codex-local": LOCAL_CODEX_AGENT_KEY,
  "local codex": LOCAL_CODEX_AGENT_KEY,
  "local-qoder": LOCAL_QODER_AGENT_KEY,
  "qoder-local": LOCAL_QODER_AGENT_KEY,
  "local qoder": LOCAL_QODER_AGENT_KEY,

  // 产品前端实现
  "frontend": NOLO_FRONTEND_AGENT_KEY,
  "frontend-agent": NOLO_FRONTEND_AGENT_KEY,
  "frontend-implementer": NOLO_FRONTEND_AGENT_KEY,
  "nolo-frontend": NOLO_FRONTEND_AGENT_KEY,
  "nolo frontend": NOLO_FRONTEND_AGENT_KEY,
  "前端agent": NOLO_FRONTEND_AGENT_KEY,
  "前端 agent": NOLO_FRONTEND_AGENT_KEY,
  "前端": NOLO_FRONTEND_AGENT_KEY,

  // Win Qwen (本地轻量无Token消耗辅助)
  "win-qwen": WIN_QWEN_AGENT_KEY,
  "win qwen": WIN_QWEN_AGENT_KEY,
  "winqwen": WIN_QWEN_AGENT_KEY,

  // 其他辅助/特定角色
  "nolo-project-manager": NOLO_PROJECT_MANAGER_AGENT_KEY,
  "project-manager": NOLO_PROJECT_MANAGER_AGENT_KEY,
  "nolo-pm": NOLO_PROJECT_MANAGER_AGENT_KEY,
  pm: NOLO_PROJECT_MANAGER_AGENT_KEY,
  "项目经理": NOLO_PROJECT_MANAGER_AGENT_KEY,
  "nolo 项目经理": NOLO_PROJECT_MANAGER_AGENT_KEY,
};

function parseAgentKeyFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\/+/, "");
  }
  return trimmed;
}

export function resolveCliAgentKeyInput(raw: string): string {
  return AGENT_ALIAS_TO_KEY[raw.trim().toLowerCase()] ?? parseAgentKeyFromInput(raw);
}

export function isLocalCliAgentKey(agentKey: string): boolean {
  return agentKey === LOCAL_CODEX_AGENT_KEY || agentKey === LOCAL_QODER_AGENT_KEY;
}
