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
import { removePageFromSpace } from "./docSpaceHelpers";
import { readOption } from "./cliEnvHelpers";
import { deleteDbRecordOnServers } from "./globalRecordOperations";
import type { DocKind, DocWriteDeps } from "./docCommandShared";

function printDocDeleteUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo doc delete (--id <pageId> | --key <pageKey>)

Options:
  --id <pageId>             Page id (without user prefix).
  --key <pageKey>           Full dbKey, e.g. page-<userId>-<pageId>.
  --sync local,main,us      Choose delete targets. Values may also be full URLs.
  --local-only              Delete only on the local server target.
  --no-local                Exclude local targets when --sync includes them.
  --dry-run                 Show what would be deleted without deleting.
  --json                    Print machine-readable JSON.
  --server <url>            Default target when --sync is omitted.
  --token <jwt>             Auth token. Required for deletes.
`);
}

function printSkillDocDeleteUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo skill-doc delete (--id <skillId> | --key <pageKey>)

Options:
  --id <skillId>            Skill id (without user prefix).
  --key <pageKey>           Full dbKey, e.g. page-<userId>-<skillId>.
  --sync local,main,us      Choose delete targets. Values may also be full URLs.
  --local-only              Delete only on the local server target.
  --no-local                Exclude local targets when --sync includes them.
  --dry-run                 Show what would be deleted without deleting.
  --json                    Print machine-readable JSON.
  --token <jwt>             Auth token. Required for deletes.
`);
}

async function runDeleteCommand(
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
  const shouldDryRun = hasFlag(args, "--dry-run");
  const shouldOutputJson = hasFlag(args, "--json");

  const { authToken, userId } = requireTokenUser(args, deps.env, shouldDryRun);
  const targets = resolveWriteTargets(args, deps.env);
  if (!targets.length) {
    throw new Error("No delete targets resolved. Check --sync / --local-only / --no-local.");
  }

  const dbKey = explicitKey ?? (docKind === "skill"
    ? buildSkillPageKey(userId, explicitId!)
    : buildPageKey(userId, explicitId!));

  const existing = await readPageRecord({ authToken, dbKey, serverUrl: targets[0] });

  if (docKind === "page" && existing?.meta?.kind === "skill") {
    throw new Error(`Target page is a skill doc. Use nolo skill-doc delete --key ${dbKey}`);
  }
  if (docKind === "skill" && existing?.meta?.kind !== "skill") {
    throw new Error(`Target page is not a skill doc. Use nolo doc delete --key ${dbKey}`);
  }

  const spaceId = typeof existing?.spaceId === "string" ? existing.spaceId : null;

  const summary = {
    dryRun: shouldDryRun,
    kind: docKind,
    dbKey,
    userId,
    spaceId,
    syncTargets: targets,
    deletedTargets: [] as string[],
  };

  if (!shouldDryRun) {
    if (spaceId) {
      for (const serverUrl of targets) {
        await removePageFromSpace({
          baseUrl: serverUrl,
          userId,
          authToken,
          spaceId,
          contentKey: dbKey,
        }).catch(() => null);
      }
    }

    const results = await deleteDbRecordOnServers({
      authToken,
      dbKey,
      fetchImpl: fetch,
      serverUrls: targets,
    });

    const failed = results.filter((result) => !result.ok);
    if (failed.length) {
      throw new Error(
        `delete ${dbKey} failed on ${failed
          .map((result) => `${result.serverUrl}: ${result.error}`)
          .join("; ")}`
      );
    }

    summary.deletedTargets.push(...results.map((result) => result.serverUrl));
  }

  if (shouldOutputJson) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else if (shouldDryRun) {
    process.stdout.write(`dry-run ok: ${dbKey}\n`);
  } else {
    process.stdout.write(`deleted ${docKind}: ${dbKey}\n`);
  }

  return 0;
}

export async function runDocDeleteCommand(args: string[], deps: DocWriteDeps) {
  return runDeleteCommand(args, deps, {
    defaultKind: "page",
    usage: printDocDeleteUsage,
  });
}

export async function runSkillDocDeleteCommand(args: string[], deps: DocWriteDeps) {
  return runDeleteCommand(args, deps, {
    defaultKind: "skill",
    usage: printSkillDocDeleteUsage,
  });
}
