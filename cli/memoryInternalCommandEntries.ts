import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";
import { runMemoryDeleteCommand } from "./memoryCommands";

export function getMemoryInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["memory", "delete"], "Delete long-term memories by filter", runMemoryDeleteCommand),
  ];
}
