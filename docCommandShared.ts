import { DEFAULT_LOCAL_API_ORIGIN } from "./core/localOrigins";
import { normalizeServerOrigin } from "./core/serverOrigin";
import { asTrimmedLowercaseString } from "./core/trimmedLowercaseString";
import { NOLO_CLUSTER_SERVERS } from "./database/config";
import { buildSkillSummaryMarker } from "./ai/skills/skillSummaryMarker";
import { writeAgentRecord, readDbRecord } from "./agentRecordHelpers";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerUrl,
} from "./cliEnvHelpers";
import { ensurePageAttachedToSpace } from "./docSpaceHelpers";
import type { EnvLike } from "./cliEnvHelpers";

export type DocKind = "page" | "skill";

export type DocWriteDeps = {
  env: NodeJS.ProcessEnv;
};

export type PageRecordTarget = {
  authToken: string;
  dbKey: string;
  record: Record<string, unknown>;
  serverUrl: string;
  spaceId: string | null;
  title: string;
  userId: string;
  skillSummary?: Record<string, unknown> | null;
};

export function hasHelpArg(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

export function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

export function normalizeBaseUrl(base: string) {
  return normalizeServerOrigin(base);
}

export function localBaseFromEnv(env: EnvLike) {
  return normalizeBaseUrl(env.SCRIPT_LOCAL_BASE_URL || DEFAULT_LOCAL_API_ORIGIN);
}

export function targetToBase(target: string, env: EnvLike) {
  const normalized = asTrimmedLowercaseString(target);
  if (normalized === "local") return localBaseFromEnv(env);
  if (normalized === "main") return normalizeBaseUrl(NOLO_CLUSTER_SERVERS[0]);
  if (normalized === "us") return normalizeBaseUrl(NOLO_CLUSTER_SERVERS[1]);
  return normalizeBaseUrl(target);
}

export function parseSyncTargets(raw: string | undefined, env: EnvLike) {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => value !== "none")
    .map((value) => targetToBase(value, env));
}

export function isLocalBaseUrl(baseUrl: string) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function resolveWriteTargets(args: string[], env: EnvLike) {
  const explicitSync = parseSyncTargets(readOption(args, "--sync"), env);
  const targets = hasFlag(args, "--local-only")
    ? [localBaseFromEnv(env)]
    : explicitSync ?? [resolveServerUrl(args, env)];
  const filtered = hasFlag(args, "--no-local")
    ? targets.filter((target) => !isLocalBaseUrl(target))
    : targets;
  return Array.from(new Set(filtered.map(normalizeBaseUrl)));
}

export function readTitle(args: string[]) {
  const valueFlags = new Set([
    "--title",
    "--description",
    "--body",
    "--body-file",
    "--space",
    "--id",
    "--kind",
    "--sync",
    "--tools",
    "--required-skills",
    "--recommended-skills",
    "--preferred-agents",
    "--trigger-mode",
    "--budget-tier",
    "--prompt-patch",
    "--token",
    "--server",
  ]);
  return readOption(args, "--title") ?? args.find((value, index) => {
    if (index === 0) return false;
    if (valueFlags.has(args[index - 1])) return false;
    return !value.startsWith("-");
  });
}

export function resolveDocKind(args: string[], fallback: DocKind): DocKind {
  if (hasFlag(args, "--page") || readOption(args, "--kind") === "page") return "page";
  return fallback;
}

export function requireTokenUser(args: string[], env: EnvLike, dryRun: boolean) {
  const authToken = resolveAuthToken(args, env);
  const userId = parseUserIdFromAuthToken(authToken) || env.USER_ID || "";
  if (!authToken && !dryRun) {
    throw new Error("doc command requires an auth token. Pass --token or set AUTH_TOKEN.");
  }
  if (!userId && !dryRun) {
    throw new Error("auth token does not contain userId. Pass a user-scoped token.");
  }
  return {
    authToken,
    userId: userId || "dry-run",
  };
}

export async function writePageRecord(args: PageRecordTarget) {
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

export async function readPageRecord(args: {
  authToken: string;
  dbKey: string;
  serverUrl: string;
}) {
  return readDbRecord({
    dbKey: args.dbKey,
    authToken: args.authToken,
    fetchImpl: fetch,
    serverUrl: args.serverUrl,
  });
}

export function buildSkillSummaryForRecord(record: Record<string, unknown>) {
  const meta = record?.meta as Record<string, unknown> | undefined;
  const skillConfig = meta?.skillConfig;
  if (!skillConfig) return undefined;
  return buildSkillSummaryMarker(meta);
}
