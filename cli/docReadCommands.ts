import { buildPageKey } from "./docPageHelpers";
import { buildSkillPageKey } from "./docSkillHelpers";
import {
  hasFlag,
  hasHelpArg,
  readPageRecord,
  requireTokenUser,
  resolveDocKind,
  resolveWriteTargets,
} from "./docCommandShared";
import { readOption } from "./cliEnvHelpers";
import type { DocKind, DocWriteDeps } from "./docCommandShared";

function printDocReadUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo doc read (--id <pageId> | --key <pageKey>)

Options:
  --id <pageId>             Page id (without user prefix).
  --key <pageKey>           Full dbKey, e.g. page-<userId>-<pageId>.
  --server <url>            Server to read from.
  --token <jwt>             Auth token. Required for reads.
`);
}

function printSkillDocReadUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo skill-doc read (--id <skillId> | --key <pageKey>)

Options:
  --id <skillId>            Skill id (without user prefix).
  --key <pageKey>           Full dbKey, e.g. page-<userId>-<skillId>.
  --server <url>            Server to read from.
  --token <jwt>             Auth token. Required for reads.
`);
}

async function runReadCommand(
  args: string[],
  deps: DocWriteDeps,
  options: { defaultKind: DocKind; usage: (output: { write(chunk: string): unknown }) => void }
) {
  if (hasHelpArg(args)) {
    options.usage(process.stdout);
    return 0;
  }

  const explicitId = readOption(args, "--id");
  const explicitKey = readOption(args, "--key");
  if (!explicitId && !explicitKey) {
    options.usage(process.stderr);
    return 1;
  }

  const docKind = resolveDocKind(args, options.defaultKind);
  const shouldOutputJson = hasFlag(args, "--json");

  const { authToken, userId } = requireTokenUser(args, deps.env, false);
  const targets = resolveWriteTargets(args, deps.env);
  if (!targets.length) {
    throw new Error("No read targets resolved. Check --server.");
  }

  const dbKey = explicitKey ?? (docKind === "skill"
    ? buildSkillPageKey(userId, explicitId!)
    : buildPageKey(userId, explicitId!));

  let record: Record<string, unknown> | null = null;
  for (const serverUrl of targets) {
    try {
      record = await readPageRecord({ authToken, dbKey, serverUrl });
      if (record) break;
    } catch {
      // try next target
    }
  }

  if (!record) {
    throw new Error(`doc not found: ${dbKey}`);
  }

  if (shouldOutputJson) {
    process.stdout.write(`${JSON.stringify({ dbKey, record }, null, 2)}\n`);
  } else {
    process.stdout.write(`read ${docKind}: ${dbKey}\n`);
    process.stdout.write(`title: ${record.title ?? "(none)"}\n`);
    process.stdout.write(`spaceId: ${record.spaceId ?? "(none)"}\n`);
  }

  return 0;
}

export async function runDocReadCommand(args: string[], deps: DocWriteDeps) {
  return runReadCommand(args, deps, {
    defaultKind: "page",
    usage: printDocReadUsage,
  });
}

export async function runSkillDocReadCommand(args: string[], deps: DocWriteDeps) {
  return runReadCommand(args, deps, {
    defaultKind: "skill",
    usage: printSkillDocReadUsage,
  });
}
