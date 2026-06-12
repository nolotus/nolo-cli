import { DEFAULT_NOLO_SERVER_URL } from "../defaultServer";
import type { AgentRuntimeRequestedMode } from "../agentRuntimeLocal";

export const DEFAULT_TUI_AGENT_KEY = "agent-pub-01NOLOAPPBLD000000019KCKT0";
export const DEFAULT_TUI_SERVER_URL = DEFAULT_NOLO_SERVER_URL;

const KNOWN_AGENTS: Array<{
  name: string;
  key: string;
  description: string;
}> = [
  {
    name: "nolo",
    key: "agent-pub-01NOLOAPPBLD000000019KCKT0",
    description: "one assistant that routes work across your agents and data",
  },
  {
    name: "app-builder",
    key: "agent-pub-01APPBUILDER00000001YAII3I",
    description: "builds web apps, tools, charts, and product prototypes",
  },
];

const KNOWN_AGENT_ALIASES: Record<string, { name: string; key: string }> =
  Object.fromEntries(KNOWN_AGENTS.map((agent) => [agent.name, agent]));

function shortenDialogId(dialogId: string) {
  return dialogId.length > 12
    ? `${dialogId.slice(0, 6)}...${dialogId.slice(-4)}`
    : dialogId;
}

export function resolveDialogLabel(
  state: Pick<TuiState, "dialogId" | "dialogLabel">
) {
  return state.dialogId ? shortenDialogId(state.dialogId) : state.dialogLabel;
}

export type TuiState = {
  agentKey: string;
  agentName: string;
  dialogId?: string;
  dialogLabel: string;
  profileName: string;
  serverUrl: string;
  cliVersion?: string;
  attachedDocs: string[];
  runtimeMode: AgentRuntimeRequestedMode;
};

export type TuiAction =
  | {
      type: "chat";
      message: string;
      agentKey: string;
      runtimeMode: AgentRuntimeRequestedMode;
      continueDialogId?: string;
    }
  | {
      type: "compact";
      dialogId: string;
    }
  | {
      type: "self-update";
    }
  | {
      type: "cli-command";
      args: string[];
    }
  | {
      type: "exit";
    };

export type TuiInputResult = {
  nextState: TuiState;
  output: string;
  action?: TuiAction;
};

type EnvLike = Record<string, string | undefined>;

export function createInitialTuiState(env: EnvLike = process.env): TuiState {
  const agentKey = env.NOLO_AGENT?.trim() || DEFAULT_TUI_AGENT_KEY;
  const agentName = env.NOLO_AGENT_NAME?.trim() || "nolo";

  return {
    agentKey,
    agentName,
    dialogId: env.NOLO_DIALOG_ID?.trim() || undefined,
    dialogLabel: env.NOLO_DIALOG?.trim() || "new",
    profileName: env.NOLO_PROFILE?.trim() || "local",
    serverUrl: (env.NOLO_SERVER || env.BASE_URL || DEFAULT_TUI_SERVER_URL).replace(
      /\/+$/,
      ""
    ),
    cliVersion: env.NOLO_CLI_VERSION?.trim() || undefined,
    attachedDocs: [],
    runtimeMode: env.NOLO_RUNTIME_MODE === "local" || env.NOLO_RUNTIME_MODE === "server"
      ? env.NOLO_RUNTIME_MODE
      : "auto",
  };
}

export function renderStatusLine(state: TuiState) {
  const docs =
    state.attachedDocs.length > 0
      ? String(state.attachedDocs.length)
      : "0";

  return [
    `agent ${state.agentName}`,
    `dialog ${resolveDialogLabel(state)}`,
    `docs ${docs}`,
    `runtime ${state.runtimeMode}`,
    `profile ${state.profileName}`,
  ].join(" | ");
}

export function renderWelcome(state: TuiState) {
  const docs = state.attachedDocs.length > 0
    ? `${state.attachedDocs.length} attached`
    : "none";
  return [
    "",
    `Nolo workspace${state.cliVersion ? `  nolo ${state.cliVersion}` : ""}`,
    `agent ${state.agentName} | dialog ${resolveDialogLabel(state)} | docs ${docs} | profile ${state.profileName}`,
    `server ${state.serverUrl}`,
    "",
    "Tell nolo what you want. Use /help for commands. Use /version if this install feels stale.",
    "",
  ].join("\n");
}

export function renderPrompt(_state: TuiState) {
  return "you > ";
}

export function renderTuiHelp() {
  return [
    "Commands:",
    "  /help                 Show this help",
    "  /new                  Start a fresh dialog",
    "  /compact              Compact current dialog and fork a new one",
    "  /context              Show workspace context and next actions",
    "  /runtime <mode>       Use auto, local, or server runtime",
    "  /agent                Show the current agent",
    "  /agents               List built-in agent shortcuts",
    "  /switch <agent>       Switch the current agent",
    "  /dialog               Show the current dialog",
    "  /doc                  List attached docs",
    "  /doc attach <doc>     Attach a doc to this workspace",
    "  /customize            Describe how you want to tune nolo",
    "  /login                Show login/profile hint",
    "  /profile              Show active profile",
    "  /update               Update the global nolo install",
    "  /version              Show version/update hint",
    "  /exit                 Leave the workspace",
    "",
    "You can also type normally. nolo routes simple read/status requests to CLI commands and sends the rest to the current agent.",
  ].join("\n");
}

export function renderContextPanel(state: TuiState) {
  const docs = state.attachedDocs.length
    ? state.attachedDocs.join(", ")
    : "none";
  return [
    "Workspace context",
    "-----------------",
    `agent   ${state.agentName}`,
    `dialog  ${resolveDialogLabel(state)}`,
    `docs    ${docs}`,
    `profile ${state.profileName}`,
    `runtime ${state.runtimeMode}`,
    `server  ${state.serverUrl}`,
    "",
    "Next:",
    "  /agents              see specialist shortcuts",
    "  /doc attach <doc>    add working context",
    "  /new                 start a clean dialog",
  ].join("\n");
}

export function renderKnownAgents() {
  return [
    "Agents:",
    ...KNOWN_AGENTS.map(
      (agent, index) =>
        `  ${index + 1}  ${agent.name.padEnd(11)} ${agent.description}`
    ),
    "",
    "Tip: stay on nolo for the one-assistant feel; switch only when you want a specialist directly.",
  ].join("\n");
}

function resolveSwitchTarget(rawTarget: string) {
  const target = rawTarget.trim();
  if (/^\d+$/.test(target)) {
    const agent = KNOWN_AGENTS[Number(target) - 1];
    return agent ? { name: agent.name, key: agent.key } : null;
  }
  const alias = KNOWN_AGENT_ALIASES[target.toLowerCase()];
  if (alias) return alias;
  if (target.startsWith("agent-") || target.startsWith("agent-pub-")) {
    return { name: target, key: target };
  }
  return null;
}

const DIALOG_ID_PATTERN = /[0-9A-HJKMNP-TV-Z]{26}/i;
const DIALOG_KEY_PATTERN = /dialog-[^\s"'<>]+-[0-9A-HJKMNP-TV-Z]{26}/i;
const DIALOG_URL_PATTERN = /https?:\/\/[^\s"'<>]+\/(?:space\/[^/\s"'<>]+\/)?dialog-[^\s"'<>]+-[0-9A-HJKMNP-TV-Z]{26}\/?/i;
const GENERIC_TOKEN_PATTERN = /(?:agent-pub-|agent-|space-|page-|meta-)?[A-Za-z0-9][A-Za-z0-9._:/-]{2,}/;

function parseChineseSmallNumber(value: string) {
  const normalized = value.trim();
  const direct: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (direct[normalized]) return direct[normalized];
  const teen = normalized.match(/^十([一二两三四五六七八九])$/);
  if (teen) return 10 + direct[teen[1]];
  const tens = normalized.match(/^([一二两三四五六七八九])十([一二两三四五六七八九])?$/);
  if (tens) return direct[tens[1]] * 10 + (tens[2] ? direct[tens[2]] : 0);
  return null;
}

function resolveDialogListLimit(input: string) {
  const digitMatch =
    input.match(/(?:最近|前|latest|last)?\s*(\d{1,3})\s*(?:个|条|篇)?\s*(?:对话|dialogs?)/i) ??
    input.match(/(?:对话|dialogs?).*?(?:最近|前|latest|last)?\s*(\d{1,3})\s*(?:个|条|篇)?/i);
  if (digitMatch) {
    const parsed = Number(digitMatch[1]);
    if (Number.isInteger(parsed) && parsed > 0) return String(parsed);
  }

  const chineseMatch =
    input.match(/(?:最近|前)?\s*([一二两三四五六七八九十]{1,3})\s*(?:个|条|篇)?\s*对话/) ??
    input.match(/对话.*?(?:最近|前)?\s*([一二两三四五六七八九十]{1,3})\s*(?:个|条|篇)?/);
  if (chineseMatch) {
    const parsed = parseChineseSmallNumber(chineseMatch[1]);
    if (parsed && parsed > 0) return String(parsed);
  }

  return undefined;
}

function extractDialogRef(input: string) {
  return (
    input.match(DIALOG_URL_PATTERN)?.[0] ??
    input.match(DIALOG_KEY_PATTERN)?.[0] ??
    input.match(DIALOG_ID_PATTERN)?.[0] ??
    null
  );
}

function extractTokenAfterKeywords(input: string, keywords: string[]) {
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = input.match(new RegExp(`${escaped}\\s+(${GENERIC_TOKEN_PATTERN.source})`, "i"));
    if (match?.[1]) return match[1];
  }
  return null;
}

function formatCliCommand(args: string[]) {
  return `nolo ${args.join(" ")}`;
}

function wantsList(input: string) {
  return /(列出|列表|有哪些|所有|我的|list|show all)/i.test(input);
}

function wantsRead(input: string) {
  return /(读|读取|查看|打开|查询|read|show|open)/i.test(input);
}

function wantsAnalysisOrComposition(input: string) {
  return /(总结|汇总|分析|归纳|对比|解释|整理|summary|summari[sz]e|analy[sz]e|compare)/i.test(input);
}

function resolveSystemCliCommand(input: string) {
  if (/(我.*登录.*谁|当前.*登录|whoami|who am i)/i.test(input)) {
    return ["whoami"];
  }
  if (/(版本|version)/i.test(input) && /(?:nolo|cli|版本|version)/i.test(input)) {
    return ["version"];
  }
  if (/(诊断|doctor|健康检查|health)/i.test(input) && /(?:nolo|cli|诊断|doctor)/i.test(input)) {
    return ["doctor"];
  }
  return null;
}

function resolveResourceCliCommand(input: string) {
  if (/(agent|代理|智能体)/i.test(input)) {
    if (wantsList(input)) return ["agent", "list"];
    if (wantsRead(input)) {
      const agentRef = extractTokenAfterKeywords(input, ["agent", "代理", "智能体"]);
      if (agentRef) return ["agent", "read", agentRef];
    }
  }

  if (/(space|空间)/i.test(input)) {
    if (wantsList(input)) return ["space", "list"];
    if (wantsRead(input)) {
      const spaceRef = extractTokenAfterKeywords(input, ["space", "空间"]);
      if (spaceRef) return ["space", "read", spaceRef];
    }
  }

  if (/(skill-doc|skill doc|技能文档|技能)/i.test(input)) {
    if (wantsRead(input)) {
      const docRef = extractTokenAfterKeywords(input, ["skill-doc", "skill doc", "技能文档", "技能"]);
      if (docRef) return ["skill-doc", "read", docRef];
    }
  }

  if (/(doc|文档|page)/i.test(input)) {
    if (wantsRead(input)) {
      const docRef = extractTokenAfterKeywords(input, ["doc", "文档", "page"]);
      if (docRef) return ["doc", "read", docRef];
    }
  }

  if (/(table|表格|表|任务表)/i.test(input) && /(查询|查看|读取|query|read|show)/i.test(input)) {
    const tableRef = extractTokenAfterKeywords(input, ["table", "表格", "表", "任务表"]);
    if (tableRef) return ["table", "query", "--table", tableRef];
  }

  return null;
}

export function resolveNaturalLanguageCliCommand(input: string): string[] | null {
  const normalized = input.trim();
  if (!normalized) return null;

  const systemCommand = resolveSystemCliCommand(normalized);
  if (systemCommand) return systemCommand;

  if (/(对话|dialog)/i.test(normalized)) {
    const dialogRef = extractDialogRef(normalized);
    if (dialogRef && wantsRead(normalized)) {
      return ["dialog", "read", dialogRef];
    }

    const shouldList = /(查|查询|查看|列出|找|最近|list|show|latest|recent)/i.test(normalized);
    if (shouldList && !dialogRef && !wantsAnalysisOrComposition(normalized)) {
      const args = ["dialog", "list"];
      const limit = resolveDialogListLimit(normalized);
      if (limit) args.push("--limit", limit);
      return args;
    }
  }

  return resolveResourceCliCommand(normalized);
}

export function handleTuiInput(input: string, state: TuiState): TuiInputResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { nextState: state, output: "" };
  }

  if (!trimmed.startsWith("/")) {
    const cliArgs = resolveNaturalLanguageCliCommand(trimmed);
    if (cliArgs) {
      return {
        nextState: state,
        output: `[nolo] ${formatCliCommand(cliArgs)}`,
        action: {
          type: "cli-command",
          args: cliArgs,
        },
      };
    }

    return {
      nextState: state,
      output: "",
      action: {
        type: "chat",
        message: trimmed,
        agentKey: state.agentKey,
        runtimeMode: state.runtimeMode,
        ...(state.dialogId ? { continueDialogId: state.dialogId } : {}),
      },
    };
  }

  const [command = "", ...rest] = trimmed.split(/\s+/);
  const argText = rest.join(" ").trim();

  switch (command) {
    case "/help":
      return { nextState: state, output: renderTuiHelp() };
    case "/context":
    case "/ctx":
      return { nextState: state, output: renderContextPanel(state) };
    case "/runtime": {
      if (argText !== "auto" && argText !== "local" && argText !== "server") {
        return {
          nextState: state,
          output: "Usage: /runtime <auto|local|server>",
        };
      }
      return {
        nextState: { ...state, runtimeMode: argText },
        output: `Runtime: ${argText}`,
      };
    }
    case "/exit":
    case "/quit":
      return { nextState: state, output: "Bye.", action: { type: "exit" } };
    case "/new":
      return {
        nextState: {
          ...state,
          dialogId: undefined,
          dialogLabel: "new",
          attachedDocs: [],
        },
        output: "Started a fresh dialog.",
      };
    case "/compact":
      if (argText) {
        return {
          nextState: state,
          output: `Unknown command: ${trimmed}\n\n${renderTuiHelp()}`,
        };
      }
      if (!state.dialogId) {
        return {
          nextState: state,
          output: "Current dialog: new (nothing to compact yet)",
        };
      }
      return {
        nextState: state,
        output: "Compacting current dialog...",
        action: { type: "compact", dialogId: state.dialogId },
      };
    case "/agent":
      return {
        nextState: state,
        output: `Current agent: ${state.agentName} (${state.agentKey})`,
      };
    case "/agents":
      return {
        nextState: state,
        output: renderKnownAgents(),
      };
    case "/switch": {
      if (!argText) {
        return {
          nextState: state,
          output: "Usage: /switch <agent-key|alias>",
        };
      }
      const resolvedTarget = resolveSwitchTarget(argText);
      if (!resolvedTarget) {
        return {
          nextState: state,
          output:
            `I don't know agent shortcut "${argText}" yet.\n` +
            "Use /switch nolo, /switch app-builder, or a full agent key like agent-pub-...",
        };
      }
      return {
        nextState: {
          ...state,
          agentName: resolvedTarget.name,
          agentKey: resolvedTarget.key,
        },
        output: `Switched to ${resolvedTarget.name}.`,
      };
    }
    case "/dialog":
      return {
        nextState: state,
        output: state.dialogId
          ? `Current dialog: ${state.dialogId}`
          : "Current dialog: new",
      };
    case "/doc": {
      if (rest[0] === "attach") {
        const docName = rest.slice(1).join(" ").trim();
        if (!docName) {
          return { nextState: state, output: "Usage: /doc attach <doc>" };
        }
        const attachedDocs = state.attachedDocs.includes(docName)
          ? state.attachedDocs
          : [...state.attachedDocs, docName];
        return {
          nextState: { ...state, attachedDocs },
          output: `Attached doc: ${docName}`,
        };
      }
      return {
        nextState: state,
        output:
          state.attachedDocs.length > 0
            ? `Attached docs: ${state.attachedDocs.join(", ")}`
            : "No docs attached. Use /doc attach <doc>.",
      };
    }
    case "/customize":
      return {
        nextState: state,
        output:
          "Tell nolo what to change, for example: /customize make my default agent more concise.",
      };
    case "/login":
      return {
        nextState: state,
        output:
          "MVP login uses profile/env auth. Set AUTH_TOKEN, NOLO_SERVER, or NOLO_PROFILE before starting nolo.",
      };
    case "/profile":
      return {
        nextState: state,
        output: `Profile: ${state.profileName}`,
      };
    case "/update":
      return {
        nextState: state,
        output: "Starting self-update...",
        action: { type: "self-update" },
      };
    case "/version":
      return {
        nextState: state,
        output:
          `nolo ${state.cliVersion || "unknown version"}\n` +
          "Update this install with: nolo update\n" +
          "If repo-local output differs, publish/install the latest npm package first.",
      };
    default:
      return {
        nextState: state,
        output: `Unknown command: ${command}\n\n${renderTuiHelp()}`,
      };
  }
}
