import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";

export function getMemoryInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["memory", "list"], "List long-term memories by filter", async (args, deps) => {
      const { runMemoryListCommand } = await import("./memoryCommands");
      return runMemoryListCommand(args, deps);
    }),
    createEnvCommand(["memory", "remember"], "Store a long-term memory", async (args, deps) => {
      const { runMemoryRememberCommand } = await import("./memoryCommands");
      return runMemoryRememberCommand(args, deps);
    }),
    createEnvCommand(["memory", "delete"], "Delete long-term memories by filter", async (args, deps) => {
      const { runMemoryDeleteCommand } = await import("./memoryCommands");
      return runMemoryDeleteCommand(args, deps);
    }),
  ];
}
