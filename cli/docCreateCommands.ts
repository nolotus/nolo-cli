import { NOLO_CLUSTER_SERVERS } from "../database/config";
import { DEFAULT_LOCAL_API_ORIGIN } from "../core/localOrigins";
import { buildSkillSummaryMarker } from "../ai/skills/skillSummaryMarker";
import { writeAgentRecord } from "./agentRecordHelpers";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerUrl,
} from "./cliEnvHelpers";
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
import { ensurePageAttachedToSpace } from "./docSpaceHelpers";
import { findPotentialSecrets, formatSecretFindings } from "./secretScan";

type DocKind = "page" | "skill";

type DocCreateDeps = {
  env: NodeJS.ProcessEnv;
};

const VALUE_FLAGS = new Set([
  "--title",
  "--description",
  "--body",
  "--body-file",
  "--id",
  "--space",
  "--sync",
  "--server",
  "--server-url",
  "--token",
  "--tools",
  "--required-skills",
  "--recommended-skills",
  "--preferred-agents",
  "--trigger-mode",
  "--budget-tier",
  "--prompt-patch",
  "--kind",
]);

function hasHelpArg(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

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

function normalizeBaseUrl(base: string) {
  return base.trim().replace(/\/+$/, "");
}

function localBaseFromEnv(env: NodeJS.ProcessEnv) {
  return normalizeBaseUrl(env.SCRIPT_LOCAL_BASE_URL || DEFAULT_LOCAL_API_ORIGIN);
}

function targetToBase(target: string, env: NodeJS.ProcessEnv) {
  const normalized = target.trim().toLowerCase();
  if (normalized === "local") return localBaseFromEnv(env);
  if (normalized === "main") return normalizeBaseUrl(NOLO_CLUSTER_SERVERS[0]);
  if (normalized === "us") return normalizeBaseUrl(NOLO_CLUSTER_SERVERS[1]);
  return normalizeBaseUrl(target);
}

function parseSyncTargets(raw: string | undefined, env: NodeJS.ProcessEnv) {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => value !== "none")
    .map((value) => targetToBase(value, env));
}

function isLocalBaseUrl(baseUrl: string) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function resolveWriteTargets(args: string[], env: NodeJS.ProcessEnv) {
  const explicitSync = parseSyncTargets(readOption(args, "--sync"), env);
  const targets = hasFlag(args, "--local-only")
    ? [localBaseFromEnv(env)]
    : explicitSync ?? [resolveServerUrl(args, env)];
  const filtered = hasFlag(args, "--no-local")
    ? targets.filter((target) => !isLocalBaseUrl(target))
    : targets;
  return Array.from(new Set(filtered.map(normalizeBaseUrl)));
}

function readTitle(args: string[]) {
  return readOption(args, "--title") ?? args.find((value, index) => {
    if (index === 0) return false;
    if (VALUE_FLAGS.has(args[index - 1])) return false;
    return !value.startsWith("-");
  });
}

function resolveDocKind(args: string[], fallback: DocKind): DocKind {
  if (hasFlag(args, "--page") || readOption(args, "--kind") === "page") return "page";
  return fallback;
}

function requireTokenUser(args: string[], env: NodeJS.ProcessEnv, dryRun: boolean) {
  const authToken = resolveAuthToken(args, env);
  const userId = parseUserIdFromAuthToken(authToken) || env.USER_ID || "";
  if (!authToken && !dryRun) {
    throw new Error("doc create requires an auth token. Pass --token or set AUTH_TOKEN.");
  }
  if (!userId && !dryRun) {
    throw new Error("auth token does not contain userId. Pass a user-scoped token.");
  }
  return {
    authToken,
    userId: userId || "dry-run",
  };
}

async function writePageRecord(args: {
  authToken: string;
  dbKey: string;
  record: Record<string, any>;
  serverUrl: string;
  spaceId: string | null;
  title: string;
  userId: string;
  skillSummary?: Record<string, any> | null;
}) {
  await writeAgentRecord({
    agentKey: args.dbKey,
    authToken: args.authToken,
    fetchImpl: fetch,
    serverUrl: args.serverUrl,
    userId: args.userId,
    record: args.record,
  });
  if (args.spaceId) {
    await ensurePageAttachedToSpace({
      baseUrl: args.serverUrl,
      userId: args.userId,
      authToken: args.authToken,
      spaceId: args.spaceId,
      contentKey: args.dbKey,
      title: args.title,
      skillSummary: args.skillSummary,
    });
  }
}

async function runCreateCommand(
  args: string[],
  deps: DocCreateDeps,
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

  const skillSummary = docKind === "skill" ? buildSkillSummaryMarker(record.meta) : undefined;
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

export async function runDocCreateCommand(args: string[], deps: DocCreateDeps) {
  return runCreateCommand(args, deps, {
    defaultKind: "page",
    usage: printDocCreateUsage,
  });
}

export async function runSkillDocCreateCommand(args: string[], deps: DocCreateDeps) {
  return runCreateCommand(args, deps, {
    defaultKind: "skill",
    usage: printSkillDocCreateUsage,
  });
}
