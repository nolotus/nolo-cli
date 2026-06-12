import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type NoloProfile = {
  serverUrl: string;
  authToken: string;
  agentKey?: string;
  agentName?: string;
};

export type NoloProfileConfig = {
  currentProfile: string;
  profiles: Record<string, NoloProfile>;
};

export function normalizeProfileServerUrl(serverUrl: string) {
  const normalized = serverUrl.trim().replace(/\/+$/, "");
  if (!normalized) return normalized;
  try {
    const url = new URL(normalized);
    if (url.protocol === "http:" && /\.?nolo\.chat$/i.test(url.hostname)) {
      url.protocol = "https:";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return normalized;
  }
  return normalized;
}

export function getDefaultProfileConfigPath() {
  return join(homedir(), ".nolo", "config.json");
}

export function loadProfileConfig(path = getDefaultProfileConfigPath()): NoloProfileConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as NoloProfileConfig;
  if (!parsed.currentProfile || !parsed.profiles?.[parsed.currentProfile]) return null;
  for (const profile of Object.values(parsed.profiles)) {
    if (!profile?.serverUrl) continue;
    profile.serverUrl = normalizeProfileServerUrl(profile.serverUrl);
  }
  return parsed;
}

export function saveDefaultProfile(
  path: string,
  profile: NoloProfile
): NoloProfileConfig {
  const config: NoloProfileConfig = {
    currentProfile: "default",
    profiles: {
      default: profile,
    },
  };
  config.profiles.default.serverUrl = normalizeProfileServerUrl(
    config.profiles.default.serverUrl
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function buildEnvFromProfile(config: NoloProfileConfig | null) {
  if (!config) return {};
  const profile = config.profiles[config.currentProfile];
  if (!profile) return {};
  return {
    NOLO_PROFILE: config.currentProfile,
    NOLO_SERVER: profile.serverUrl,
    AUTH_TOKEN: profile.authToken,
    ...(profile.agentKey ? { NOLO_AGENT: profile.agentKey } : {}),
    ...(profile.agentName ? { NOLO_AGENT_NAME: profile.agentName } : {}),
  };
}

export function buildCliRuntimeEnv(
  processEnv: NodeJS.ProcessEnv,
  config: NoloProfileConfig | null
) {
  const profileEnv = buildEnvFromProfile(config);
  const explicitServerUrl =
    processEnv.NOLO_SERVER || processEnv.NOLO_SERVER_URL || processEnv.BASE_URL;
  return {
    ...processEnv,
    ...profileEnv,
    ...(explicitServerUrl
      ? {
          NOLO_SERVER: explicitServerUrl,
          BASE_URL: explicitServerUrl,
        }
      : {}),
  };
}

export function getCurrentProfile(config: NoloProfileConfig | null) {
  if (!config) return null;
  return config.profiles[config.currentProfile] ?? null;
}
