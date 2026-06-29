import {
  buildPageKey,
  buildPageRecord,
  readBodyArg,
} from "./docPageHelpers";
import {
  buildSkillPageKey,
  buildSkillPageRecord,
  parseJsonArg,
} from "./docSkillHelpers";
import {
  buildSkillSummaryForRecord,
  hasFlag,
  hasHelpArg,
  readPageRecord,
  readTitle,
  requireTokenUser,
  resolveDocKind,
  resolveWriteTargets,
  writePageRecord,
} from "./docCommandShared";
import { parseSkillDocProtocol, resolvePageSkillMetadata } from "./ai/skills/skillDocProtocol";
import { readOption } from "./cliEnvHelpers";
import { findPotentialSecrets, formatSecretFindings } from "./secretScan";
import type { DocKind, DocWriteDeps } from "./docCommandShared";

function printDocUpdateUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo doc update (--id <pageId> | --key <pageKey>) [--title ...] [--body ... | --body-file path] [--space ...]

Options:
  --id <pageId>             Page id (without user prefix).
  --key <pageKey>           Full dbKey, e.g. page-<userId>-<pageId>.
  --title <text>            New title.
  --description <text>      New page description stored in meta.
  --body <text>             New page body.
  --body-file <path>       Read body from file.
  --space <spaceId>         Move/attach the page to this space.
  --sync local,main,us      Choose write targets. Values may also be full URLs.
  --local-only              Write only to the local server target.
  --no-local                Exclude local targets when --sync includes them.
  --dry-run                 Build and validate without writing.
  --json                    Print machine-readable JSON.
  --allow-secrets           Allow bodies that look like credentials.
  --server <url>            Default write target when --sync is omitted.
  --token <jwt>             Auth token. Required for writes.
`);
}

function printSkillDocUpdateUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo skill-doc update (--id <skillId> | --key <pageKey>) [--title ...] [--description ...] [--body ... | --body-file path]

Options:
  --id <skillId>            Skill id (without user prefix).
  --key <pageKey>           Full dbKey, e.g. page-<userId>-<skillId>.
  --title <text>            New skill name.
  --description <text>      New skill description.
  --body <text>             New skill body.
  --body-file <path>       Read body from file.
  --space <spaceId>         Move/attach the skill page to this space.
  --tools '["readDoc"]'                 Replace tool names this skill expects.
  --required-skills '["skill-a"]'       Replace required skill references.
  --recommended-skills '["skill-b"]'    Replace recommended skill references.
  --preferred-agents '["agent-key"]'    Replace preferred agent keys.
  --trigger-mode explicit|required|recommended
  --budget-tier low|medium|high
  --prompt-patch <text>
  --sync local,main,us                  Choose write targets. Values may also be full URLs.
  --local-only                          Write only to the local server target.
  --no-local                            Exclude local targets when --sync includes them.
  --dry-run                             Build and validate without writing.
  --json                                Print machine-readable JSON.
  --allow-secrets                       Allow bodies that look like credentials.
  --token <jwt>                         Auth token. Required for writes.
`);
}

async function resolveExistingRecord(args: {
  authToken: string;
  dbKey: string;
  targets: string[];
}) {
  for (const serverUrl of args.targets) {
    try {
      const record = await readPageRecord({
        authToken: args.authToken,
        dbKey: args.dbKey,
        serverUrl,
      });
      if (record) {
        return { record, serverUrl };
      }
    } catch {
      // try next target
    }
  }
  throw new Error(`doc not found on any target: ${args.dbKey}`);
}

async function runUpdateCommand(
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
  const allowSecrets = hasFlag(args, "--allow-secrets");

  const { authToken, userId } = requireTokenUser(args, deps.env, shouldDryRun);
  const targets = resolveWriteTargets(args, deps.env);
  if (!targets.length) {
    throw new Error("No write targets resolved. Check --sync / --local-only / --no-local.");
  }

  const dbKey = explicitKey ?? (docKind === "skill"
    ? buildSkillPageKey(userId, explicitId!)
    : buildPageKey(userId, explicitId!));

  const { record: existing } = await resolveExistingRecord({ authToken, dbKey, targets });

  if (docKind === "page" && existing?.meta?.kind === "skill") {
    throw new Error(`Target page is a skill doc. Use nolo skill-doc update --key ${dbKey}`);
  }
  if (docKind === "skill" && existing?.meta?.kind !== "skill") {
    throw new Error(`Target page is not a skill doc. Use nolo doc update --key ${dbKey}`);
  }

  const title = readTitle(args) ?? existing?.title;
  if (!title) {
    throw new Error(`doc has no title and none was provided: ${dbKey}`);
  }

  const newSpaceId = readOption(args, "--space");
  const spaceId = newSpaceId !== undefined ? newSpaceId : (existing?.spaceId ?? null);

  let record: Record<string, any>;
  let skillSummary: Record<string, any> | undefined;

  if (docKind === "skill") {
    const meta = resolvePageSkillMetadata(existing);
    const currentConfig = meta?.skillConfig;
    if (!currentConfig) {
      throw new Error(`existing skill doc is missing skillConfig: ${dbKey}`);
    }

    const parsed = parseSkillDocProtocol(existing?.content ?? "", meta);
    const description = readOption(args, "--description") ?? currentConfig.description;
    const body = readBodyArg(args, parsed.content ?? "");

    const secretFindings = findPotentialSecrets(body);
    if (secretFindings.length && !allowSecrets) {
      throw new Error(
        [
          "Document body appears to contain credentials or secrets. Pass --allow-secrets to write it anyway.",
          formatSecretFindings(secretFindings),
        ].join("\n")
      );
    }

    const mergedConfig = {
      ...currentConfig,
      name: title,
      description,
      ...(parseJsonArg<string[]>(readOption(args, "--tools"), currentConfig.toolNames ?? []).length
        ? { toolNames: parseJsonArg<string[]>(readOption(args, "--tools"), currentConfig.toolNames ?? []) }
        : {}),
      ...(parseJsonArg<string[]>(readOption(args, "--required-skills"), currentConfig.requiredSkills ?? []).length
        ? { requiredSkills: parseJsonArg<string[]>(readOption(args, "--required-skills"), currentConfig.requiredSkills ?? []) }
        : {}),
      ...(parseJsonArg<string[]>(readOption(args, "--recommended-skills"), currentConfig.recommendedSkills ?? []).length
        ? { recommendedSkills: parseJsonArg<string[]>(readOption(args, "--recommended-skills"), currentConfig.recommendedSkills ?? []) }
        : {}),
      ...(parseJsonArg<string[]>(readOption(args, "--preferred-agents"), currentConfig.preferredAgents ?? []).length
        ? { preferredAgents: parseJsonArg<string[]>(readOption(args, "--preferred-agents"), currentConfig.preferredAgents ?? []) }
        : {}),
      ...(readOption(args, "--trigger-mode")
        ? { triggerMode: readOption(args, "--trigger-mode") as "explicit" | "required" | "recommended" }
        : {}),
      ...(readOption(args, "--budget-tier")
        ? { budgetTier: readOption(args, "--budget-tier") as "low" | "medium" | "high" }
        : {}),
      ...(readOption(args, "--prompt-patch") !== undefined
        ? { promptPatch: readOption(args, "--prompt-patch") }
        : {}),
    };

    const skillId = typeof existing?.id === "string" ? existing.id : dbKey.split("-").pop()!;
    record = buildSkillPageRecord({
      dbKey,
      skillId,
      title,
      spaceId,
      body,
      skillConfig: mergedConfig,
      existing,
    });
    skillSummary = buildSkillSummaryForRecord(record);
  } else {
    const description = readOption(args, "--description") ?? existing?.meta?.description ?? "";
    const body = readBodyArg(args, typeof existing?.content === "string" ? existing.content : "");

    const secretFindings = findPotentialSecrets(body);
    if (secretFindings.length && !allowSecrets) {
      throw new Error(
        [
          "Document body appears to contain credentials or secrets. Pass --allow-secrets to write it anyway.",
          formatSecretFindings(secretFindings),
        ].join("\n")
      );
    }

    const pageId = typeof existing?.id === "string" ? existing.id : dbKey.split("-").pop()!;
    record = buildPageRecord({
      dbKey,
      pageId,
      title,
      spaceId,
      content: body,
      existing,
      meta: description ? { description } : undefined,
    });
  }

  const summary = {
    dryRun: shouldDryRun,
    kind: docKind,
    title,
    dbKey,
    userId,
    spaceId,
    syncTargets: targets,
    writtenTargets: [] as string[],
  };

  if (!shouldDryRun) {
    for (const serverUrl of targets) {
      await writePageRecord({
        authToken,
        dbKey,
        record,
        serverUrl,
        spaceId,
        title,
        userId,
        skillSummary,
      });
      summary.writtenTargets.push(serverUrl);
    }
  }

  if (shouldOutputJson) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else if (shouldDryRun) {
    process.stdout.write(`dry-run ok: ${dbKey}\n`);
  } else {
    process.stdout.write(`updated ${docKind}: ${dbKey}\n`);
  }

  return 0;
}

export async function runDocUpdateCommand(args: string[], deps: DocWriteDeps) {
  return runUpdateCommand(args, deps, {
    defaultKind: "page",
    usage: printDocUpdateUsage,
  });
}

export async function runSkillDocUpdateCommand(args: string[], deps: DocWriteDeps) {
  return runUpdateCommand(args, deps, {
    defaultKind: "skill",
    usage: printSkillDocUpdateUsage,
  });
}
