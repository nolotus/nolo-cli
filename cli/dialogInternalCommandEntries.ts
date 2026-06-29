import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";

export function getDialogInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["dialog", "list"], "List dialogs", async (args, deps) => {
      const { runDialogListCommand } = await import("./dialogCommands");
      return runDialogListCommand(args, deps);
    }),
    createEnvCommand(["dialog", "delete"], "Delete one or more dialogs", async (args, deps) => {
      const { runDialogDeleteCommand } = await import("./dialogCommands");
      return runDialogDeleteCommand(args, deps);
    }),
    createEnvCommand(["dialog", "query"], "Query dialogs by subject refs", async (args, deps) => {
      const { runDialogQueryCommand } = await import("./dialogCommands");
      return runDialogQueryCommand(args, deps);
    }),
    createEnvCommand(["dialog", "read"], "Read a dialog", async (args, deps) => {
      const { runDialogReadCommand } = await import("./dialogCommands");
      return runDialogReadCommand(args, deps);
    }),
    createEnvCommand(["dialog", "status"], "Read compact dialog status", async (args, deps) => {
      const { runDialogStatusCommand } = await import("./dialogCommands");
      return runDialogStatusCommand(args, deps);
    }),
  ];
}
