import { DEFAULT_LOCAL_API_ORIGIN } from "../core/localOrigins";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import { NOLO_CLUSTER_SERVERS } from "../database/config";

export type EnvLike = Record<string, string | undefined>;

export function resolveServerUrlFromEnv(env: EnvLike) {
  return (env.NOLO_SERVER || env.BASE_URL || DEFAULT_NOLO_SERVER_URL).replace(/\/+$/, "");
}

type ResolverInput = string[] | EnvLike;

function isCliArgs(value: ResolverInput): value is string[] {
  return Array.isArray(value);
}

function buildServerCandidates(values: Array<string | null | undefined>) {
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.replace(/\/+$/, ""))
  )];
}

export function resolveServerUrl(env: EnvLike): string;
export function resolveServerUrl(args: string[], env: EnvLike): string;
export function resolveServerUrl(input: ResolverInput, env?: EnvLike) {
  if (isCliArgs(input)) {
    const explicit =
      readOption(input, "--server-url") ||
      readOption(input, "--server");
    return explicit?.replace(/\/+$/, "") || resolveServerUrlFromEnv(env ?? {});
  }
  return resolveServerUrlFromEnv(input);
}

export function resolveServerCandidates(env: EnvLike, preferred?: string | null): string[];
export function resolveServerCandidates(
  args: string[],
  env: EnvLike,
  preferred?: string | null,
): string[];
export function resolveServerCandidates(
  input: ResolverInput,
  envOrPreferred?: EnvLike | string | null,
  preferred?: string | null,
) {
  if (isCliArgs(input)) {
    const env = (envOrPreferred ?? {}) as EnvLike;
    const explicitServer = resolveServerUrl(input, env);
    return buildServerCandidates([
      explicitServer,
      preferred?.trim(),
      env.NOLO_SERVER,
      env.BASE_URL,
      env.NOLO_SERVER_URL,
      DEFAULT_NOLO_SERVER_URL,
      ...NOLO_CLUSTER_SERVERS,
    ]);
  }

  const env = input;
  return buildServerCandidates([
    typeof envOrPreferred === "string" ? envOrPreferred.trim() : undefined,
    env.NOLO_SERVER,
    env.BASE_URL,
    env.NOLO_SERVER_URL,
    DEFAULT_NOLO_SERVER_URL,
    ...NOLO_CLUSTER_SERVERS,
  ]);
}

function resolveDeleteServerCandidatesFromEnv(
  env: EnvLike,
  ...preferredValues: Array<string | null | undefined>
) {
  return buildServerCandidates([
    ...preferredValues,
    env.NOLO_SERVER,
    env.BASE_URL,
    env.NOLO_SERVER_URL,
    env.READ_DIALOG_BASE,
    DEFAULT_NOLO_SERVER_URL,
    ...NOLO_CLUSTER_SERVERS,
    DEFAULT_LOCAL_API_ORIGIN,
  ]);
}

export function resolveDeleteServerCandidates(env: EnvLike, preferred?: string | null): string[];
export function resolveDeleteServerCandidates(
  args: string[],
  env: EnvLike,
  preferred?: string | null,
): string[];
export function resolveDeleteServerCandidates(
  input: ResolverInput,
  envOrPreferred?: EnvLike | string | null,
  preferred?: string | null,
) {
  if (isCliArgs(input)) {
    const env = (envOrPreferred ?? {}) as EnvLike;
    const explicitServer = resolveServerUrl(input, env);
    return resolveDeleteServerCandidatesFromEnv(env, explicitServer, preferred?.trim());
  }
  const env = input;
  return resolveDeleteServerCandidatesFromEnv(
    env,
    typeof envOrPreferred === "string" ? envOrPreferred.trim() : undefined,
  );
}

export function resolveAuthTokenFromEnv(env: EnvLike, extraEnvKeys: string[] = []) {
  for (const key of ["AUTH_TOKEN", "AUTH", ...extraEnvKeys]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function resolveAuthToken(env: EnvLike, extraEnvKeys?: string[]): string;
export function resolveAuthToken(args: string[], env: EnvLike, extraEnvKeys?: string[]): string;
export function resolveAuthToken(
  input: ResolverInput,
  envOrExtraEnvKeys?: EnvLike | string[],
  extraEnvKeys: string[] = [],
) {
  if (isCliArgs(input)) {
    const env = (envOrExtraEnvKeys ?? {}) as EnvLike;
    return (
      readOption(input, "--token") ||
      readOption(input, "--machine-key") ||
      resolveAuthTokenFromEnv(env, extraEnvKeys)
    );
  }
  return resolveAuthTokenFromEnv(input, (envOrExtraEnvKeys as string[] | undefined) ?? []);
}

export function parseUserIdFromAuthToken(token: string) {
  const parts = token.trim().split(".").filter(Boolean);
  const payloadCandidates = parts.length >= 3 ? [parts[1], parts[0]] : [parts[0]];
  for (const payload of payloadCandidates) {
    if (!payload) continue;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      if (typeof parsed?.userId === "string") return parsed.userId;
    } catch {
      // Try the next token shape.
    }
  }
  return "";
}

export function readOption(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
