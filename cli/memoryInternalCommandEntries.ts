import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";

export function getMemoryInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["memory", "delete"], "Delete long-term memories by filter", async (args, deps) => {
      const { runMemoryDeleteCommand } = await import("./memoryCommands");
      return runMemoryDeleteCommand(args, deps);
    }),
  ];
}
