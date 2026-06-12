import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveLaunchableCodexCommand } from "./codexBinary";

type EnvLike = Record<string, string | undefined>;

type DetectRuntimeCapabilitiesOptions = {
  commandExists?: (command: string) => boolean;
  commandLaunchable?: (command: string, args: string[]) => boolean;
  env?: EnvLike;
  probeLaunchable?: boolean;
};

type CommandProbe = {
  command: string;
  args: string[];
};

const COMMAND_CAPABILITIES: Array<[probes: CommandProbe[], capabilities: string[]]> = [
  [[{ command: "codex", args: ["--version"] }], ["codex-cli"]],
  [[{ command: "claude", args: ["--version"] }], ["claude-code"]],
  [
    [
      { command: "gh", args: ["--version"] },
      { command: "gh", args: ["copilot", "--", "--help"] },
    ],
    ["copilot-cli"],
  ],
  [[{ command: "gemini", args: ["--version"] }], ["gemini-cli"]],
  [[{ command: "kimi", args: ["--version"] }], ["kimi-cli"]],
  [[{ command: "agy", args: ["--help"] }], ["agy-cli"]],
  [[{ command: "qoder", args: ["--version"] }], ["qoder-cli", "qoder-usage"]],
];

function defaultCommandExists(command: string) {
  const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return pathEntries.some((entry) =>
    extensions.some((extension) => existsSync(join(entry, `${command}${extension}`)))
  );
}

function defaultCommandLaunchable(command: string, args: string[]) {
  const executable = command === "codex" ? resolveLaunchableCodexCommand() : command;
  const result = spawnSync(executable, args, {
    stdio: "pipe",
    timeout: 3_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function detectRuntimeCapabilities(
  options: DetectRuntimeCapabilitiesOptions = {}
): string[] {
  const commandExists = options.commandExists ?? defaultCommandExists;
  const commandLaunchable = options.commandLaunchable ?? defaultCommandLaunchable;
  const env = options.env ?? process.env;
  const capabilities: string[] = [];

  for (const [probes, detectedCapabilities] of COMMAND_CAPABILITIES) {
    if (!probes.every((probe) => commandExists(probe.command))) continue;
    if (options.probeLaunchable && !probes.every((probe) => commandLaunchable(probe.command, probe.args))) {
      continue;
    }
    capabilities.push(...detectedCapabilities);
  }

  if (env.NOLO_LOCAL_LLM_ENDPOINT || env.LLAMA_SERVER_URL) {
    capabilities.push("local-llm");
  }

  return capabilities;
}
