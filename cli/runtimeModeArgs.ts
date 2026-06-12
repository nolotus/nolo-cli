import type { AgentRuntimeRequestedMode } from "./agentRuntimeLocal";

type TuiLaunchMode = {
  shouldStartTui: boolean;
  envPatch: Record<string, string>;
};

function runtimeModeFromFlag(flag: string): AgentRuntimeRequestedMode | "" {
  if (flag === "--local") return "local";
  if (flag === "--server") return "server";
  if (flag === "--auto") return "auto";
  return "";
}

export function resolveTuiLaunchMode(args: string[]): TuiLaunchMode {
  const command = args[0];
  if (command !== "chat" && command !== "tui") {
    return { shouldStartTui: false, envPatch: {} };
  }
  if (args.length === 1) {
    return { shouldStartTui: true, envPatch: {} };
  }
  if (args.length === 2) {
    const mode = runtimeModeFromFlag(args[1] ?? "");
    if (mode) {
      return {
        shouldStartTui: true,
        envPatch: { NOLO_RUNTIME_MODE: mode },
      };
    }
  }
  return { shouldStartTui: false, envPatch: {} };
}
