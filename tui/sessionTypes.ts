import type { AgentRuntimeRequestedMode } from "../agentRuntimeLocal";
import type { ThinkingDisplayMode } from "../client/thinkingOutput";
import type { TurnTokenUsage } from "../client/tokenUsage";
import type { ToolDisplayMode } from "../client/toolOutput";
import type { AttachedImage } from "./pasteImage";
import type { GitStatus } from "./gitStatus";

export type TuiState = {
  agentKey: string;
  agentName: string;
  dialogId?: string;
  dialogKey?: string;
  dialogOwnerId?: string;
  dialogLabel: string;
  profileName: string;
  serverUrl: string;
  cliVersion?: string;
  /**
   * 用于解析 paste 行里的相对路径。workspace 启动时从 process.cwd() 取。
   * 保留在 state 里是为了让 handleTuiInput 这种纯函数也能做路径解析。
   */
  cwd: string;
  attachedDocs: string[];
  /**
   * Skill refs attached to the workspace via /skill attach.
   * Each entry is a dbKey (page-xxx) or a bare skill name resolved
   * against .agents/skills/<name>/SKILL.md or docs/skills/<name>.md.
   * Passed to buildSkillContextBlocks on every chat turn so the agent
   * sees the skill content in system context blocks.
   * /new clears these, same semantics as attachedDocs.
   */
  attachedSkills: string[];
  /**
   * 暂存 / paste 行解析到的图片附件。
   * 提交 chat 时会消费这些,转成 imageUrls 一起送出去。
   * /new 时清空,跟 attachedDocs 同语义。
   */
  attachedImages: AttachedImage[];
  runtimeMode: AgentRuntimeRequestedMode;
  /**
   * 显示在状态栏里的模式标签,默认等于 runtimeMode。
   * 可通过 NOLO_CLI_STATUS_MODE 覆盖,例如设置为 high。
   */
  modeLabel: string;
  gitStatus?: GitStatus;
  thinkingDisplay: ThinkingDisplayMode;
  toolDisplay: ToolDisplayMode;
  turnTokens?: TurnTokenUsage;
  /**
   * Measured estimate of built-in system+tools context (AGENTS.md, guidance,
   * skill index, tool schemas). Used by the status chip until provider usage
   * arrives in turnTokens.
   */
  estimatedContextTokens?: number;
  /** Resolved from agentName at init / agent-switch; fallback when turnTokens has no contextWindow. */
  contextWindow?: number;
  /** 执行来源：platform=平台API(计费) custom=自定义API cli=订阅制。platform 时状态行显示积分。 */
  apiSource?: string;
};

export type TuiAction =
  | {
      type: "chat";
      message: string;
      agentKey: string;
      runtimeMode: AgentRuntimeRequestedMode;
      continueDialogId?: string;
      /**
       * 行内或 /attach 命令解析到的图片绝对路径。
       * 这里只携带路径,workspace loop 会异步读成 data URL 后拼 imageUrls。
       * 失败(ENOENT/超过大小/不是图片)的会被丢弃,留在 message 里给用户文本。
       */
      imagePaths?: string[];
    }
  | {
      type: "compact";
      dialogId: string;
    }
  | {
      type: "self-update";
    }
  | {
      type: "shell-command";
      command: string;
    }
  | {
      type: "pick-agent";
    }
  | {
      type: "list-agents";
    }
  | {
      type: "pick-dialog";
    }
  | {
      type: "set-locale";
      locale: "zh" | "en";
    }
  | {
      type: "copy-last";
    }
  | {
      type: "copy-view";
    }
  | {
      type: "set-mouse";
      enabled: boolean;
    }
  | {
      type: "set-altscreen";
      enabled: boolean;
    }
  | {
      type: "clear";
    }
  | {
      type: "exit";
    };

export type TuiInputResult = {
  nextState: TuiState;
  output: string;
  action?: TuiAction;
};

export type TuiKeyInfo = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
};

export type TuiInputKeyResult = {
  buffer: string;
  cursorPos?: number;
  submit?: string;
  abort?: boolean;
  copyView?: boolean;
};
