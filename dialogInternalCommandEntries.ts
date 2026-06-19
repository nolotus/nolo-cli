import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";
import {
  runDialogDeleteCommand,
  runDialogListCommand,
  runDialogQueryCommand,
  runDialogReadCommand,
  runDialogStatusCommand,
} from "./dialogCommands";

export function getDialogInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["dialog", "list"], "List dialogs", runDialogListCommand),
    createEnvCommand(["dialog", "delete"], "Delete one or more dialogs", runDialogDeleteCommand),
    createEnvCommand(["dialog", "query"], "Query dialogs by subject refs", runDialogQueryCommand),
    createEnvCommand(["dialog", "read"], "Read a dialog", runDialogReadCommand),
    createEnvCommand(["dialog", "status"], "Read compact dialog status", runDialogStatusCommand),
  ];
}
