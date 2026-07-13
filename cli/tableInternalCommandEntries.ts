import { createArgsCommand, createEnvCommand } from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";

export function renderTableHelpText() {
  return [
    "nolo table — table metadata and row commands",
    "",
    "Usage:",
    "  nolo table list [--limit <n>] [--output items|json|jsonl]",
    "  nolo table query --table <tableId|metaKey> [--row <rowId|rowDbKey>] [--output items|json|jsonl]",
    "  nolo table meta --name <name> [--table <tableId|metaKey>] [--columns <json-array>]",
    "  nolo table add-row --table <tableId|metaKey> --values <json-object>",
    "  nolo table update-row --table <tableId|metaKey> --row <rowId|rowDbKey> --changes <json-object>",
    "  nolo table update-rows --table <tableId|metaKey> --updates <json-array>",
    "  nolo table delete-row --table <tableId|metaKey> --row <rowId|rowDbKey>",
  "  nolo table delete-rows --table <tableId|metaKey> (--row-ids <json-array> | --row-dbkeys <json-array> | --filters <json-object>)",
    "",
    "Examples:",
    '  nolo table query --table meta-0e95801d90-01KWSK4Q4TESXQ06SW39JN2TTJ --columns \'["title","status","owner","priority","codeStatus"]\' --no-base-fields --output items',
    '  nolo table meta --table meta-0e95801d90-01KWSK4Q4TESXQ06SW39JN2TTJ --name "01KWSK4Q4TESXQ06SW39JN2TTJ"',
    '  nolo table add-row --table meta-0e95801d90-01KWSK4Q4TESXQ06SW39JN2TTJ --values \'{"title":"Task","status":"todo"}\'',
    "",
  ].join("\n");
}

function isTableHelpArgs(args: string[]) {
  return args.length === 0 || args.every((arg) => arg === "--help" || arg === "-h");
}

export function getTableInternalCommandEntries(): CommandEntry[] {
  return [
    createArgsCommand(["table"], "Show table command help", async (args) => {
      if (!isTableHelpArgs(args)) {
        console.error(`Unknown command: table ${args.join(" ")}`);
        return 1;
      }
      console.log(renderTableHelpText());
      return 0;
    }),
    createArgsCommand(["table", "delete-rows"], "Delete table rows", async (args) => {
      // Dynamic import keeps a broken command module from crashing the whole CLI at startup.
      const { runTableDeleteRowsCommand } = await import("./tableCommands");
      return runTableDeleteRowsCommand(args);
    }),
    createEnvCommand(["table", "add-column"], "Add a table column", async (args, deps) => {
      const { runTableAddColumnCommand } = await import("./tableCommands");
      return runTableAddColumnCommand(args, deps);
    }),
    createEnvCommand(["table", "add-row"], "Add a table row", async (args, deps) => {
      const { runTableAddRowCommand } = await import("./tableCommands");
      return runTableAddRowCommand(args, deps);
    }),
    createEnvCommand(["table", "add-rows"], "Add table rows", async (args, deps) => {
      const { runTableAddRowsCommand } = await import("./tableCommands");
      return runTableAddRowsCommand(args, deps);
    }),
    createEnvCommand(["table", "update-row"], "Update a table row", async (args, deps) => {
      const { runTableUpdateRowCommand } = await import("./tableCommands");
      return runTableUpdateRowCommand(args, deps);
    }),
    createEnvCommand(["table", "update-rows"], "Update table rows", async (args, deps) => {
      const { runTableUpdateRowsCommand } = await import("./tableCommands");
      return runTableUpdateRowsCommand(args, deps);
    }),
    createEnvCommand(["table", "delete-row"], "Delete a table row", async (args, deps) => {
      const { runTableDeleteRowCommand } = await import("./tableCommands");
      return runTableDeleteRowCommand(args, deps);
    }),
  ];
}
