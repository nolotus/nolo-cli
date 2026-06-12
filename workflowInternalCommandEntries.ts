import { createEnvCommand } from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";
import { runTableListCommand, runTableQueryCommand } from "./tableCommands";

export function getWorkflowInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["table", "list"], "List table metadata", runTableListCommand),
    createEnvCommand(["table", "query"], "Query table rows", runTableQueryCommand),
  ];
}
