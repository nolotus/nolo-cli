import {
  buildPageKey,
  buildPageRecord,
  createPageId,
  readBodyArg,
} from "./docPageHelpers";
import {
  buildSkillDocId,
  buildSkillPageKey,
  buildSkillPageRecord,
  parseJsonArg,
} from "./docSkillHelpers";
import {
  buildSkillSummaryForRecord,
  hasFlag,
  hasHelpArg,
  readTitle,
  requireTokenUser,
  resolveDocKind,
  resolveWriteTargets,
  writePageRecord,
} from "./docCommandShared";
import { readOption } from "./cliEnvHelpers";
import { findPotentialSecrets, formatSecretFindings } from "./secretScan";
import type { DocKind, DocWriteDeps } from "./docCommandShared";

function printDocCreateUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo doc create --title <title> [--body ... | --body-file path] [--id ...] [--space ...]

Options:
  --description <text>      Optional page description stored in meta.
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

function printSkillDocCreateUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo skill-doc create --title <title> --description <text> [--body ... | --body-file path]
  nolo skill create-doc --title <title> --description <text> [--body ... | --body-file path]

Options:
  --tools '["readDoc"]'                 Tool names this skill expects.
  --required-skills '["skill-a"]'       Required skill references.
  --recommended-skills '["skill-b"]'    Recommended skill references.
  --preferred-agents '["agent-key"]'    Preferred agent keys.
  --trigger-mode explicit|required|recommended
  --budget-tier low|medium|high
  --prompt-patch <text>
  --page | --kind page                  Create a normal page instead of a skill-backed page.
  --sync local,main,us                  Choose write targets. Values may also be full URLs.
  --dry-run                             Build and validate without writing.
  --json                                Print machine-readable JSON.
  --token <jwt>                         Auth token. Required for writes.
`);
}

async function runCreateCommand(
  args: string[],
  deps: DocWriteDeps,
  options: { defaultKind: DocKind; usage: (output: { write(chunk: string): unknown }) => void }
) {
  if (hasHelpArg(args)) {
    options.usage(process.stdout);
    return 0;
  }

  const title = readTitle(args);
  const description = readOption(args, "--description") ?? "";
  const docKind = resolveDocKind(args, options.defaultKind);
  const shouldDryRun = hasFlag(args, "--dry-run");
  const shouldOutputJson = hasFlag(args, "--json");
  const allowSecrets = hasFlag(args, "--allow-secrets");
  const spaceId = readOption(args, "--space") ?? null;

  if (!title || (docKind === "skill" && !description)) {
    options.usage(process.stderr);
    return 1;
  }

  const body = readBodyArg(args, "");
  const secretFindings = findPotentialSecrets(body);
  if (secretFindings.length && !allowSecrets) {
    throw new Error(
      [
        "Document body appears to contain credentials or secrets. Pass --allow-secrets to write it anyway.",
        formatSecretFindings(secretFindings),
      ].join("\n")
    );
  }

  const { authToken, userId } = requireTokenUser(args, deps.env, shouldDryRun);
  const targets = resolveWriteTargets(args, deps.env);
  if (!targets.length) {
    throw new Error("No write targets resolved. Check --sync / --local-only / --no-local.");
  }

  const explicitId = readOption(args, "--id");
  const docId = explicitId ?? (docKind === "skill" ? buildSkillDocId(title) : createPageId());
  const dbKey = docKind === "skill" ? buildSkillPageKey(userId, docId) : buildPageKey(userId, docId);
  const record =
    docKind === "skill"
      ? buildSkillPageRecord({
          dbKey,
          skillId: docId,
          title,
          spaceId,
          body,
          skillConfig: {
            version: "0.1",
            kind: "skill",
            id: docId,
            name: title,
            description,
            ...(parseJsonArg<string[]>(readOption(args, "--tools"), []).length
              ? { toolNames: parseJsonArg<string[]>(readOption(args, "--tools"), []) }
              : {}),
            ...(parseJsonArg<string[]>(readOption(args, "--required-skills"), []).length
              ? { requiredSkills: parseJsonArg<string[]>(readOption(args, "--required-skills"), []) }
              : {}),
            ...(parseJsonArg<string[]>(readOption(args, "--recommended-skills"), []).length
              ? { recommendedSkills: parseJsonArg<string[]>(readOption(args, "--recommended-skills"), []) }
              : {}),
            ...(parseJsonArg<string[]>(readOption(args, "--preferred-agents"), []).length
              ? { preferredAgents: parseJsonArg<string[]>(readOption(args, "--preferred-agents"), []) }
              : {}),
            ...(readOption(args, "--trigger-mode")
              ? { triggerMode: readOption(args, "--trigger-mode") as "explicit" | "required" | "recommended" }
              : {}),
            ...(readOption(args, "--budget-tier")
              ? { budgetTier: readOption(args, "--budget-tier") as "low" | "medium" | "high" }
              : {}),
            ...(readOption(args, "--prompt-patch") ? { promptPatch: readOption(args, "--prompt-patch") } : {}),
          },
        })
      : buildPageRecord({
          dbKey,
          pageId: docId,
          title,
          spaceId,
          content: body,
          meta: description ? { description } : undefined,
        });

  const skillSummary = buildSkillSummaryForRecord(record);
  const summary = {
    dryRun: shouldDryRun,
    kind: docKind,
    title,
    dbKey,
    id: docId,
    userId,
    spaceId,
    syncTargets: targets,
    writtenTargets: [] as string[],
    secretFindingCount: secretFindings.length,
    secretFindings,
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
    process.stdout.write(`created ${docKind}: ${dbKey}\n`);
  }

  return 0;
}

export async function runDocCreateCommand(args: string[], deps: DocWriteDeps) {
  return runCreateCommand(args, deps, {
    defaultKind: "page",
    usage: printDocCreateUsage,
  });
}

export async function runSkillDocCreateCommand(args: string[], deps: DocWriteDeps) {
  return runCreateCommand(args, deps, {
    defaultKind: "skill",
    usage: printSkillDocCreateUsage,
  });
}
