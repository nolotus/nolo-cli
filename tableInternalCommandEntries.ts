import { createArgsCommand } from "./cliCommandFactories";
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
    "  nolo table delete-rows --table <tableId|metaKey> --row-ids <json-array> | --row-dbkeys <json-array>",
    "",
    "Examples:",
    '  nolo table query --table meta-0e95801d90-NOLOTASKBOARD --columns \'["title","status","owner","priority","codeStatus"]\' --no-base-fields --output items',
    '  nolo table meta --table meta-0e95801d90-NOLOTASKBOARD --name "NOLOTASKBOARD"',
    '  nolo table add-row --table meta-0e95801d90-NOLOTASKBOARD --values \'{"title":"Task","status":"todo"}\'',
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
  ];
}
