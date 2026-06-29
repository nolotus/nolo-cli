import { createEnvCommand } from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";

export function getWorkflowInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["table", "list"], "List table metadata", async (args, deps) => {
      // Dynamic import keeps a broken command module from crashing the whole CLI at startup.
      const { runTableListCommand } = await import("./tableCommands");
      return runTableListCommand(args, deps);
    }),
    createEnvCommand(["table", "query"], "Query table rows", async (args, deps) => {
      // Dynamic import keeps a broken command module from crashing the whole CLI at startup.
      const { runTableQueryCommand } = await import("./tableCommands");
      return runTableQueryCommand(args, deps);
    }),
  ];
}
