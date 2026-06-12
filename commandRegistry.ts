export type { CliPackageInfo, CliRuntimeContext, CommandEntry } from "./cliCommandTypes";
export {
  createCliRuntimeContext,
  looksLikeDaemonShortcut,
  runResolvedCommand,
} from "./cliCommandDispatch";
import type { CommandEntry } from "./cliCommandTypes";
import { getInternalCommandEntries } from "./internalCommandEntries";
import { getScriptCommandEntries } from "./scriptCommandEntries";

export const COMMANDS: CommandEntry[] = [
  ...getInternalCommandEntries(renderHelpText),
  ...getScriptCommandEntries(),
];

export const GROUP_ORDER = [
  "run",
  "chat",
  "doc",
  "skill-doc",
  "skill",
  "agent",
  "doctor",
  "dialog",
  "memory",
  "space",
  "table",
  "llama",
  "model-runtime",
  "dev",
] as const;

export function renderHelpText() {
  const lines = [
    "nolo — Agent-first terminal workspace",
    "",
    "Usage:",
    "  nolo",
    "  nolo <command> [subcommand] [...args]",
    "  nolo doctor",
    "  nolo update",
    "",
    "Examples:",
    "  nolo",
    "  nolo chat",
    "  nolo login",
    "  nolo login --no-browser",
    "  nolo login --token <auth-token>",
    "  nolo whoami",
    "  nolo connect",
    "  nolo connect --watch",
    "  nolo connect --ws",
    "  nolo connect --ws --server-url https://api.nolo.chat --machine-key sk_machine_xxx",
    "  nolo connect --daemon --server-url https://api.nolo.chat --machine-key sk_machine_xxx",
    "  nolo machine status",
    "  nolo doctor",
    "  nolo doctor runtime",
    "  nolo update",
    '  nolo run "review this repository"  # no Nolo login required; uses local Codex CLI',
    '  nolo doc create --title "Trip Notes" --body "hello" --sync local,us --dry-run',
    '  nolo skill-doc create --title "Agent Query Skill" --description "Inspect recent agent dialogs" --sync local,main,us',
    "  nolo agent list --json",
    "  nolo space list --json",
    "  nolo agent pull agent-pub-01APPBUILDER00000001YAII3I",
  "  nolo agent read agent-pub-01APPBUILDER00000001YAII3I",
    "  nolo agent usage qoder",
  '  nolo agent run frontend-implementer --msg "polish notifications"',
    "  nolo agent bind-current agent-user-1-agent-1",
    "  nolo agent runtime-doctor agent-user-1-agent-1",
    '  nolo agent smoke-current agent-user-1-agent-1 --msg "ping"',
    '  nolo chat --agent agent-pub-01APPBUILDER00000001YAII3I --msg "你好"',
    "  nolo memory delete --source-dialog 01ABC... --yes --json",
    "  nolo space read 01KKY77TT0DA9NY7TNW3R7255N --content-key page-user-id --brief",
    "  nolo space delete --name-prefix rn_owner_verify_0504 --yes",
    "  nolo table query --table 01ABCXYZ",
    '  nolo table query --table meta-0e95801d90-NOLOTASKBOARD --columns \'["title","status","owner","priority","codeStatus"]\' --no-base-fields --output items',
    '  nolo table update-row --table meta-0e95801d90-NOLOTASKBOARD --row 01ROWID --changes \'{"status":"已完成"}\'',
    "  nolo llama status",
  ];

  for (const group of GROUP_ORDER) {
    const commands = COMMANDS.filter((entry) => entry.path[0] === group);
    if (commands.length === 0) continue;
    lines.push("", group);
    for (const entry of commands) {
      lines.push(`  ${entry.path.join(" ")}  ${entry.description}`);
    }
  }

  return lines.join("\n");
}

export function resolveCommand(args: string[]) {
  const sorted = [...COMMANDS].sort((a, b) => b.path.length - a.path.length);
  return sorted.find((entry) =>
    entry.path.every((part, index) => args[index] === part)
  );
}
