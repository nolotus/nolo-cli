import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import { DEFAULT_NOLO_SERVER_URL } from "../defaultServer";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
} from "../cliEnvHelpers";
import {
  normalizeRenderDisplayMode,
} from "../client/assistantOutput";
import {
  normalizeThinkingDisplayMode,
} from "../client/thinkingOutput";
import {
  normalizeToolDisplayMode,
} from "../client/toolOutput";
import {
  DEFAULT_TUI_AGENT_KEY,
  resolveCatalogPlatformAgents,
} from "./agentCatalog";
import { resolveAgentSwitchTarget } from "./agentPicker";
import { detectImagePaths, summarizeAttachment } from "./pasteImage";
import { parseCliLocale, setCliLocale, t } from "./i18n";
import {
  getActiveThemeName,
  setActiveThemeName,
  getActiveBrightness,
  setActiveBrightness,
  resolveTuiBrightness,
  getActiveDensity,
  setActiveDensity,
  THEME_PALETTES,
} from "./theme";
import { detectGitStatus } from "./gitStatus";
import { getProcessRegistry } from "../../agent-runtime/processRegistry";
import { formatElapsedSeconds, renderContextPanel, renderKnownAgents, renderTuiHelp } from "./sessionRender";
import { isLikelySlashCommand, stripImageTokens } from "./sessionInput";
import type { TuiState, TuiInputResult } from "./sessionTypes";

export { DEFAULT_TUI_AGENT_KEY };
export const DEFAULT_TUI_SERVER_URL = DEFAULT_NOLO_SERVER_URL;

type EnvLike = Record<string, string | undefined>;

export function createInitialTuiState(env: EnvLike = process.env): TuiState {
  const agentKey =
    asOptionalTrimmedString(env.NOLO_AGENT) ?? DEFAULT_TUI_AGENT_KEY;
  const agentName = asOptionalTrimmedString(env.NOLO_AGENT_NAME) ?? "nolo";
  const cwd = (
    asOptionalTrimmedString(env.NOLO_CWD) ?? process.cwd()
  ).replace(/\/+$/, "");
  const runtimeMode =
    env.NOLO_RUNTIME_MODE === "local" || env.NOLO_RUNTIME_MODE === "server"
      ? env.NOLO_RUNTIME_MODE
      : "auto";
  const dialogId = asOptionalTrimmedString(env.NOLO_DIALOG_ID);
  const dialogOwnerId =
    parseUserIdFromAuthToken(
      resolveAuthToken(env, ["BENCHMARK_AUTH_TOKEN"])
    ) || undefined;
  const dialogEnvValue = asOptionalTrimmedString(env.NOLO_DIALOG);
  const explicitDialogKey =
    asOptionalTrimmedString(env.NOLO_DIALOG_KEY) ??
    (dialogEnvValue?.startsWith("dialog-") ? dialogEnvValue : undefined);

  return {
    agentKey,
    agentName,
    dialogId,
    dialogKey:
      explicitDialogKey ??
      (dialogId && dialogOwnerId
        ? `dialog-${dialogOwnerId}-${dialogId}`
        : undefined),
    dialogOwnerId,
    dialogLabel: dialogEnvValue ?? "new",
    profileName: asOptionalTrimmedString(env.NOLO_PROFILE) ?? "local",
    serverUrl: (env.NOLO_SERVER || env.BASE_URL || DEFAULT_TUI_SERVER_URL).replace(
      /\/+$/,
      ""
    ),
    cliVersion: asOptionalTrimmedString(env.NOLO_CLI_VERSION),
    cwd,
    attachedDocs: [],
    attachedSkills: [],
    attachedImages: [],
    runtimeMode,
    modeLabel:
      asOptionalTrimmedString(env.NOLO_CLI_STATUS_MODE) ?? runtimeMode,
    gitStatus:
      env.NOLO_CLI_GIT_STATUS === "0" ? undefined : detectGitStatus(cwd),
    thinkingDisplay: normalizeThinkingDisplayMode(
      env.NOLO_CLI_THINKING ?? env.NOLO_THINKING,
      "hide"
    ),
    toolDisplay: normalizeToolDisplayMode(env.NOLO_CLI_TOOLS ?? env.NOLO_TOOLS, "compact"),
    renderDisplay: normalizeRenderDisplayMode(env.NOLO_CLI_RENDER ?? env.NOLO_RENDER, "rich"),
  };
}


function applyAgentSwitch(state: TuiState, target: { name: string; key: string }) {
  return {
    nextState: {
      ...state,
      agentName: target.name,
      agentKey: target.key,
    },
    output: `Switched to ${target.name}. ${
      state.dialogId ? `Dialog kept: ${state.dialogId}` : "Dialog kept: new"
    }`,
  };
}

// Removed natural language TUI routing helper functions and patterns as natural language inputs are now directly handled by the AI agent.

export function handleTuiInput(input: string, state: TuiState): TuiInputResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { nextState: state, output: "" };
  }

  if (trimmed.startsWith("!")) {
    const cmd = trimmed.slice(1).trim();
    return {
      nextState: state,
      output: "",
      action: {
        type: "shell-command",
        command: cmd,
      },
    };
  }

  if (!isLikelySlashCommand(trimmed)) {
    const hints = detectImagePaths(trimmed, state.cwd);
    const stripped = stripImageTokens(trimmed, hints);
    const finalMessage = stripped.length > 0 ? stripped : trimmed;
    const imagePaths = hints.map((hint) => hint.resolvedPath);
    const preview =
      hints.length > 0
        ? hints.map((hint) => `found image: ${hint.resolvedPath}`).join("\n")
        : "";

    return {
      nextState: state,
      output: preview,
      action: {
        type: "chat",
        message: finalMessage,
        agentKey: state.agentKey,
        runtimeMode: state.runtimeMode,
        ...(state.dialogId ? { continueDialogId: state.dialogId } : {}),
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
      },
    };
  }

  const [command = "", ...rest] = trimmed.split(/\s+/);
  const argText = rest.join(" ").trim();

  switch (command) {
    case "/help":
      return { nextState: state, output: renderTuiHelp() };
    case "/theme": {
      const parts = argText.split(/\s+/);
      const sub = parts[0]?.trim();
      const available = Object.keys(THEME_PALETTES).join(", ");
      if (!sub) {
        const brightness = getActiveBrightness() ?? `${resolveTuiBrightness()} (auto)`;
        return {
          nextState: state,
          output: [
            `Current theme: ${getActiveThemeName()} · ${brightness}`,
            `Usage: /theme <name> | /theme light | /theme dark`,
            `Available themes: ${available}`,
          ].join("\n"),
        };
      }
      // Brightness is a separate axis from the palette family: the same theme
      // has a light and a dark variant, and picking the wrong one is what makes
      // colors look washed out. It was previously reachable only through the
      // NOLO_TUI_THEME env var, which nobody discovers.
      if (sub === "light" || sub === "dark") {
        setActiveBrightness(sub);
        return { nextState: state, output: `Switched to ${sub} background colors.` };
      }
      if (sub === "auto") {
        setActiveBrightness(null);
        return {
          nextState: state,
          output: `Background colors follow terminal detection (now: ${resolveTuiBrightness()}).`,
        };
      }
      if (setActiveThemeName(sub)) {
        return {
          nextState: state,
          output: `Switched to theme: ${sub}`,
        };
      } else {
        return {
          nextState: state,
          output: `Unknown theme: ${sub}. Available themes: ${available}`,
        };
      }
    }
    case "/density": {
      const parts = argText.split(/\s+/);
      const sub = parts[0]?.trim();
      if (!sub) {
        return {
          nextState: state,
          output: `Current density: ${getActiveDensity()}\nUsage: /density <cozy|spacious>`,
        };
      }
      if (sub === "cozy" || sub === "spacious") {
        setActiveDensity(sub);
        return {
          nextState: state,
          output: `Switched to layout density: ${sub}`,
        };
      } else {
        return {
          nextState: state,
          output: `Unknown density: ${sub}. Use 'cozy' or 'spacious'.`,
        };
      }
    }
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
    case "/tools": {
      if (!argText) {
        return {
          nextState: state,
          output: `Tool display: ${state.toolDisplay} (hide | compact | verbose)`,
        };
      }
      const normalizedArg = asTrimmedLowercaseString(argText);
      if (!["hide", "compact", "verbose", "on", "off"].includes(normalizedArg)) {
        return {
          nextState: state,
          output: "Usage: /tools <hide|compact|verbose>",
        };
      }
      const nextMode = normalizeToolDisplayMode(normalizedArg, state.toolDisplay);
      return {
        nextState: { ...state, toolDisplay: nextMode },
        output: `Tool display: ${nextMode}`,
      };
    }
    case "/thinking": {
      if (!argText) {
        return {
          nextState: state,
          output: `Thinking display: ${state.thinkingDisplay} (hide | marker | show)`,
        };
      }
      const normalizedArg = asTrimmedLowercaseString(argText);
      if (!["hide", "marker", "show", "on", "off"].includes(normalizedArg)) {
        return {
          nextState: state,
          output: "Usage: /thinking <hide|marker|show>",
        };
      }
      const nextMode = normalizeThinkingDisplayMode(normalizedArg, state.thinkingDisplay);
      return {
        nextState: { ...state, thinkingDisplay: nextMode },
        output: `Thinking display: ${nextMode}`,
      };
    }
    case "/render": {
      if (!argText) {
        return {
          nextState: state,
          output: `Render display: ${state.renderDisplay} (plain | rich)`,
        };
      }
      const normalizedArg = asTrimmedLowercaseString(argText);
      if (!["plain", "rich", "on", "off"].includes(normalizedArg)) {
        return {
          nextState: state,
          output: "Usage: /render <plain|rich>",
        };
      }
      const nextMode = normalizeRenderDisplayMode(normalizedArg, state.renderDisplay);
      return {
        nextState: { ...state, renderDisplay: nextMode },
        output: `Render display: ${nextMode}`,
      };
    }
    case "/tasks":
    case "/jobs":
    case "/procs": {
      const registry = getProcessRegistry();
      const all = registry.list();
      const running = all.filter(p => p.status === "running");
      const stopped = all.filter(p => p.status !== "running");
      const lines: string[] = [];
      if (running.length > 0) {
        lines.push(`Running processes (${running.length}):`);
        for (const p of running) {
          const elapsed = formatElapsedSeconds(Math.floor((Date.now() - p.startedAt) / 1000));
          lines.push(`  pid ${p.pid}  ${p.label}    running  ${elapsed}`);
        }
      }
      if (stopped.length > 0) {
        lines.push(`Stopped/exited (${stopped.length}):`);
        for (const p of stopped) {
          const elapsed = formatElapsedSeconds(Math.floor((Date.now() - p.startedAt) / 1000));
          const exitInfo = p.exitCode !== undefined ? `  exit ${p.exitCode}` : "";
          lines.push(`  pid ${p.pid}  ${p.label}    ${p.status}${exitInfo ? ` ${exitInfo}` : ""}  ${elapsed}`);
        }
      }
      if (all.length === 0) {
        lines.push("No processes.");
      }
      return { nextState: state, output: lines.join("\n") };
    }
    case "/stop": {
      const registry = getProcessRegistry();
      if (!argText) {
        return { nextState: state, output: "Usage: /stop <pid|label|all>" };
      }
      if (argText === "all") {
        const before = registry.list().filter(p => p.status === "running").length;
        registry.stopAll();
        return { nextState: state, output: `Stopped ${before} processes` };
      }
      if (/^\d+$/.test(argText)) {
        const pid = parseInt(argText, 10);
        const proc = registry.get(pid);
        if (!proc || proc.status !== "running") {
          return { nextState: state, output: `No running process with pid ${pid}` };
        }
        registry.kill(pid);
        return { nextState: state, output: `Stopped pid ${pid} (${proc.label})` };
      }
      // Match by label
      const matches = registry.list().filter(p => p.status === "running" && p.label === argText);
      if (matches.length === 0) {
        return { nextState: state, output: `No running process labeled '${argText}'` };
      }
      for (const p of matches) {
        registry.kill(p.pid);
      }
      const stoppedNames = matches.map(p => `pid ${p.pid} (${p.label})`).join(", ");
      return { nextState: state, output: `Stopped ${stoppedNames}` };
    }
    case "/exit":
    case "/quit":
      return { nextState: state, output: t("bye"), action: { type: "exit" } };
    case "/new":
      return {
        nextState: {
          ...state,
          dialogId: undefined,
          dialogKey: undefined,
          dialogLabel: t("newDialog"),
          attachedDocs: [],
          attachedSkills: [],
          attachedImages: [],
          turnTokens: undefined,
        },
        output: t("startedFreshDialog"),
        action: { type: "clear" },
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
    case "/switch": {
      if (!argText) {
        return {
          nextState: state,
          output: "",
          action: { type: "pick-agent" },
        };
      }
      if (argText === "list") {
        return {
          nextState: state,
          output: "",
          action: { type: "list-agents" },
        };
      }
      if (argText === "current" || argText === "show") {
        return {
          nextState: state,
          output: `Current agent: ${state.agentName} (${state.agentKey})`,
        };
      }
      const resolvedTarget = resolveAgentSwitchTarget(argText, resolveCatalogPlatformAgents());
      if (!resolvedTarget) {
        return {
          nextState: state,
          output:
            `I don't know agent "${argText}" yet.\n` +
            "Use /switch, /switch list, /switch minimax-m3, or a full agent key.",
        };
      }
      return applyAgentSwitch(state, resolvedTarget);
    }
    case "/agents":
      return {
        nextState: state,
        output: renderKnownAgents(),
      };
    case "/lang": {
      const locale = parseCliLocale(argText);
      if (!locale) {
        return { nextState: state, output: t("langUsage") };
      }
      setCliLocale(locale);
      return {
        nextState: state,
        output: t("langSwitched"),
        action: { type: "set-locale", locale },
      };
    }
    case "/history":
      return {
        nextState: state,
        output: "",
        action: { type: "pick-dialog" },
      };
    case "/copy":
      if (argText === "view") {
        return {
          nextState: state,
          output: "",
          action: { type: "copy-view" },
        };
      }
      if (argText) {
        return { nextState: state, output: t("copyUsage") };
      }
      return {
        nextState: state,
        output: "",
        action: { type: "copy-last" },
      };
    case "/mouse": {
      if (argText !== "on" && argText !== "off") {
        return { nextState: state, output: t("mouseUsage") };
      }
      return {
        nextState: state,
        output: argText === "on" ? t("mouseOn") : t("mouseOff"),
        action: { type: "set-mouse", enabled: argText === "on" },
      };
    }
    case "/resume": {
      if (!argText) {
        return {
          nextState: state,
          output: "",
          action: { type: "pick-dialog" },
        };
      }
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(argText)) {
        return {
          nextState: state,
          output: `"${argText}" ${t("resumeInvalidId")}`,
        };
      }
      return {
        nextState: {
          ...state,
          dialogId: argText,
          dialogKey: state.dialogOwnerId
            ? `dialog-${state.dialogOwnerId}-${argText}`
            : undefined,
          dialogLabel: argText,
          turnTokens: undefined,
        },
        output: `${t("resumedDialogPrefix")}: ${argText}`,
      };
    }
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
    case "/skill": {
      const sub = rest[0]?.trim();
      if (sub === "attach") {
        const skillRef = rest.slice(1).join(" ").trim();
        if (!skillRef) {
          return { nextState: state, output: "Usage: /skill attach <skill-ref>" };
        }
        const attachedSkills = state.attachedSkills.includes(skillRef)
          ? state.attachedSkills
          : [...state.attachedSkills, skillRef];
        return {
          nextState: { ...state, attachedSkills },
          output: `Attached skill: ${skillRef}`,
        };
      }
      if (sub === "detach") {
        const skillRef = rest.slice(1).join(" ").trim();
        if (!skillRef) {
          return { nextState: state, output: "Usage: /skill detach <skill-ref>" };
        }
        const attachedSkills = state.attachedSkills.filter((s) => s !== skillRef);
        return {
          nextState: { ...state, attachedSkills },
          output: state.attachedSkills.includes(skillRef)
            ? `Detached skill: ${skillRef}`
            : `Skill not attached: ${skillRef}`,
        };
      }
      if (sub === "clear") {
        if (state.attachedSkills.length === 0) {
          return { nextState: state, output: "No skills attached." };
        }
        return {
          nextState: { ...state, attachedSkills: [] },
          output: `Cleared ${state.attachedSkills.length} skill(s).`,
        };
      }
      return {
        nextState: state,
        output:
          state.attachedSkills.length > 0
            ? `Attached skills: ${state.attachedSkills.join(", ")}\nUsage: /skill attach <ref> | /skill detach <ref> | /skill clear`
            : "No skills attached. Use /skill attach <skill-ref> to attach a skill.\nSkill refs can be a dbKey (page-xxx), a skill name (searched in .agents/skills/ then docs/skills/), or a direct path.",
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
        output: `当前配置环境 (Profile): ${state.profileName}`,
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
