import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { canonicalizeNoloServerUrl } from "../../core/noloServerUrl";

export type NoloProfile = {
  serverUrl: string;
  authToken?: string;
  agentKey?: string;
  agentName?: string;
};

export type NoloProfileConfig = {
  currentProfile: string;
  profiles: Record<string, NoloProfile>;
};

/** Shared pure seam (`core/noloServerUrl`) — keep CLI export name stable. */
export const normalizeProfileServerUrl = canonicalizeNoloServerUrl;

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

export function clearProfileAuthToken(path = getDefaultProfileConfigPath()): boolean {
  const config = loadProfileConfig(path);
  if (!config) return false;
  const profile = config.profiles[config.currentProfile];
  if (!profile?.authToken?.trim()) return false;
  delete profile.authToken;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

export function saveDefaultProfile(
  path: string,
  profile: { serverUrl: string; authToken: string }
): NoloProfileConfig {
  const existing = loadProfileConfig(path);
  const mergedDefault: NoloProfile = {
    ...(existing?.profiles?.default ?? {}),
    serverUrl: normalizeProfileServerUrl(profile.serverUrl),
    authToken: profile.authToken.trim(),
  };
  const config: NoloProfileConfig = {
    currentProfile: "default",
    profiles: {
      ...(existing?.profiles ?? {}),
      default: mergedDefault,
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function buildEnvFromProfile(
  config: NoloProfileConfig | null
): Record<string, string | undefined> {
  if (!config) return {};
  const profile = config.profiles[config.currentProfile];
  if (!profile) return {};
  return {
    NOLO_PROFILE: config.currentProfile,
    NOLO_SERVER: profile.serverUrl,
    ...(profile.authToken?.trim() ? { AUTH_TOKEN: profile.authToken.trim() } : {}),
    ...(profile.agentKey ? { NOLO_AGENT: profile.agentKey } : {}),
    ...(profile.agentName ? { NOLO_AGENT_NAME: profile.agentName } : {}),
  };
}

export function buildCliRuntimeEnv(
  processEnv: NodeJS.ProcessEnv,
  config: NoloProfileConfig | null
): Record<string, string | undefined> {
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

export function saveProfileAgentSelection(
  selection: { agentKey: string; agentName: string },
  path = getDefaultProfileConfigPath()
): NoloProfileConfig | null {
  const config = loadProfileConfig(path);
  if (!config) return null;
  const profile = config.profiles[config.currentProfile];
  if (!profile) return null;
  profile.agentKey = selection.agentKey.trim();
  profile.agentName = selection.agentName.trim();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}
