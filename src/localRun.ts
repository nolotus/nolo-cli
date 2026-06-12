export const LOCAL_CODEX_AGENT_KEY = "local-codex";

export type LocalRunCommand = "run" | "chat";

export type ParsedLocalRun = {
  agentKey: string;
  message: string;
  runtimeMode: "local" | "remote-or-configured";
  requiresNoloAuth: boolean;
  cwd?: string;
  eventsMode?: "jsonl";
};

type ParseLocalRunOptions = {
  command: LocalRunCommand;
};

function readFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function positionalArgs(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

export function parseLocalRunArgs(
  args: string[],
  options: ParseLocalRunOptions
): ParsedLocalRun | null {
  const explicitAgent = readFlagValue(args, "--agent");
  const explicitMessage = readFlagValue(args, "--msg");
  const positional = positionalArgs(args);
  const noLoginShorthand = !explicitAgent && (options.command === "run" || options.command === "chat");
  const agentKey = explicitAgent ?? (noLoginShorthand ? LOCAL_CODEX_AGENT_KEY : positional[0]);
  const rawMessage = explicitMessage ?? positional.slice(noLoginShorthand ? 0 : 1).join(" ");
  const message = rawMessage.trim();

  if (!agentKey || !message) return null;

  const eventsMode = readFlagValue(args, "--events") === "jsonl" ? "jsonl" : undefined;
  const cwd = readFlagValue(args, "--cwd");

  return {
    agentKey,
    message,
    runtimeMode: noLoginShorthand ? "local" : "remote-or-configured",
    requiresNoloAuth: !noLoginShorthand,
    cwd,
    eventsMode,
  };
}

export function formatLocalRunUsage(command: LocalRunCommand) {
  if (command === "chat") {
    return [
      "Usage: nolo chat <message> [--cwd <path>] [--events jsonl]",
      "       nolo chat --agent <agent> --msg <message> [--cwd <path>]",
      "Without --agent, this uses local Codex in the current workspace; no Nolo login required.",
    ].join("\n");
  }

  return [
    "Usage: nolo run <message> [--cwd <path>] [--events jsonl]",
    "       nolo run --msg <message> [--cwd <path>]",
    "Runs local Codex in the current workspace; no Nolo login required.",
  ].join("\n");
}
