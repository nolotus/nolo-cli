import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { canonicalizeNoloServerUrl } from "../core/noloServerUrl";

export type NoloProfile = {
  serverUrl: string;
  authToken?: string;
  agentKey?: string;
  agentName?: string;
  /** TUI interface language saved by /lang; surfaces as NOLO_LANG. */
  locale?: "zh" | "en";
};

export type NoloProfileConfig = {
  currentProfile: string;
  profiles: Record<string, NoloProfile>;
};

/** Shared pure seam (`core/noloServerUrl`) — keep CLI export name stable. */
export const normalizeProfileServerUrl = canonicalizeNoloServerUrl;

/**
 * A test process must never rewrite the developer's own profile. TUI tests
 * drive the real workspace loop, and the workspace persists agent/locale
 * choices through this module — so a test that switches agents used to land in
 * the developer's `~/.nolo/config.json` and pin their startup agent until they
 * noticed and cleared it by hand. Tests that legitimately exercise persistence
 * either pass an explicit path or set `NOLO_HOME`; both stay allowed.
 *
 * Edge case worth knowing: a real user running the CLI with `NODE_ENV=test` in
 * their shell gets their agent/locale choices silently not persisted (the
 * session still honours them). That is a strictly better failure than a test
 * run rewriting their profile, which is the case this exists for.
 */
export function isProtectedHomeProfileWrite(path: string) {
  if (process.env.NODE_ENV !== "test") return false;
  // Only the developer's real config is off limits. An isolated NOLO_HOME
  // resolves to a different path, so persistence tests are unaffected.
  return path === join(homedir(), ".nolo", "config.json");
}

export function getDefaultProfileConfigPath() {
  const noloHome = process.env.NOLO_HOME?.trim();
  return noloHome
    ? join(noloHome, "config.json")
    : join(homedir(), ".nolo", "config.json");
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
  if (isProtectedHomeProfileWrite(path)) return false;
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
  // Unlike the best-effort writers above, login must not fail silently — a
  // test process aimed at the real profile is a bug, so say so loudly.
  if (isProtectedHomeProfileWrite(path)) {
    throw new Error(
      `Refusing to write the developer's real profile from a test process: ${path}. ` +
        "Pass a temp path or set NOLO_HOME.",
    );
  }
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
    ...(profile.locale ? { NOLO_LANG: profile.locale } : {}),
  };
}

export function buildCliRuntimeEnv(
  processEnv: NodeJS.ProcessEnv,
  config: NoloProfileConfig | null
): Record<string, string | undefined> {
  const profileEnv = buildEnvFromProfile(config);
  // Ambient env wins over profile, mirroring NOLO_SERVER handling below.
  // Explicit AUTH_TOKEN/AUTH set in the shell overrides the saved profile
  // token; `--token`/`--machine-key` flags still win at the command layer.
  const explicitAuthToken =
    processEnv.AUTH_TOKEN || processEnv.AUTH;
  const explicitServerUrl =
    processEnv.NOLO_SERVER || processEnv.NOLO_SERVER_URL || processEnv.BASE_URL;
  // Where the startup agent came from, so the TUI can say so out loud instead
  // of silently coming up on an agent the user has no memory of choosing.
  const agentSource = processEnv.NOLO_AGENT?.trim()
    ? "env"
    : profileEnv.NOLO_AGENT
      ? "profile"
      : undefined;
  return {
    ...profileEnv,
    ...processEnv,
    NOLO_AGENT_SOURCE: agentSource,
    ...(explicitAuthToken
      ? { AUTH_TOKEN: explicitAuthToken }
      : {}),
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

export function saveProfileLocale(
  locale: "zh" | "en",
  path = getDefaultProfileConfigPath()
): NoloProfileConfig | null {
  if (isProtectedHomeProfileWrite(path)) return null;
  const config = loadProfileConfig(path);
  if (!config) return null;
  const profile = config.profiles[config.currentProfile];
  if (!profile) return null;
  profile.locale = locale;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

/** Audit trail for agent-selection writes; lives next to the profile config. */
export function getAgentSelectionAuditPath(
  configPath = getDefaultProfileConfigPath()
) {
  return join(dirname(configPath), "agent-selection.log");
}

const AGENT_SELECTION_AUDIT_MAX_BYTES = 512 * 1024;
const AGENT_SELECTION_AUDIT_KEEP_LINES = 200;

/**
 * Flags whose value is a secret. `--row-dbkey` and friends only *look* like
 * keys, so match on the whole flag rather than a substring.
 */
const SECRET_ARGV_FLAGS = new Set([
  "--token",
  "--auth",
  "--auth-token",
  "--key",
  "--api-key",
  "--app-key",
  "--machine-key",
  "--provider-api-key",
  "--invite-token",
  "--password",
  "--secret",
]);

/**
 * Mask secrets before they reach the audit log. The whole point of this log is
 * that it gets read and pasted around while debugging, and `nolo login --token
 * <auth-token>` puts a live credential in argv.
 */
export function redactArgvSecrets(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  let maskNext = false;
  for (const arg of argv) {
    if (maskNext) {
      maskNext = false;
      redacted.push("[REDACTED]");
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0 && SECRET_ARGV_FLAGS.has(arg.slice(0, equals))) {
      redacted.push(`${arg.slice(0, equals)}=[REDACTED]`);
      continue;
    }
    // A bare secret flag masks the value that follows it.
    maskNext = SECRET_ARGV_FLAGS.has(arg);
    redacted.push(arg);
  }
  return redacted;
}

/**
 * Record every agent-selection write. The startup agent is derived from
 * `profile.agentKey`, and this function is the only writer — so when the TUI
 * comes up on an agent nobody remembers choosing, this log is the only way to
 * attribute the write to a process (which binary, which argv, which call site)
 * instead of re-deriving it from behaviour. Append-only JSONL, best-effort:
 * an unwritable log must never break the actual selection write.
 */
export function appendAgentSelectionAudit(
  entry: {
    previous: { agentKey?: string; agentName?: string };
    next: { agentKey: string; agentName: string };
    configPath: string;
  },
  auditPath = getAgentSelectionAuditPath(entry.configPath)
) {
  try {
    // The stack is captured here, so drop this frame and the writer's frame to
    // land on the caller that actually decided to change the agent.
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2, 8)
      .map((line) => line.trim())
      .filter(Boolean);
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      // Distinguishes repo source / installed binary / bundled desktop build —
      // the field that says whether a stale build is doing the writing.
      execPath: process.execPath,
      argv: redactArgvSecrets(process.argv),
      cwd: process.cwd(),
      previous: entry.previous,
      next: entry.next,
      stack,
    })}\n`;
    mkdirSync(dirname(auditPath), { recursive: true });
    // It sits next to config.json (which holds the auth token); match the
    // 0600 convention the credential stores use.
    const auditMode = 0o600;
    // Rotate by keeping the tail, not by wiping: the newest entries are the
    // ones attribution depends on, and an emptied log makes the current
    // selection look like it was written by a build that predates auditing.
    if (
      existsSync(auditPath) &&
      statSync(auditPath).size > AGENT_SELECTION_AUDIT_MAX_BYTES
    ) {
      const kept = readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((entry) => entry.trim())
        .slice(-AGENT_SELECTION_AUDIT_KEEP_LINES)
        .join("\n");
      writeFileSync(auditPath, `${kept}\n`, {
        encoding: "utf8",
        mode: auditMode,
      });
    }
    appendFileSync(auditPath, line, { encoding: "utf8", mode: auditMode });
    try {
      // `mode` only applies when the file is created, so tighten an existing
      // log too — same best-effort pattern as the credential stores.
      chmodSync(auditPath, auditMode);
    } catch {
      // Platforms that ignore chmod must not break the write.
    }
  } catch {
    // Auditing is best-effort; never block the selection write.
  }
}

/**
 * The most recent audited selection, or null when the log is missing/unreadable.
 * A pinned agent that does not match this record was written by a process that
 * predates the audit trail (a stale installed binary, a bundled desktop build)
 * — which is itself the answer to "who keeps changing my default agent?".
 */
export function readLastAgentSelectionAudit(
  auditPath = getAgentSelectionAuditPath()
): {
  /** False when nothing ever audited here — i.e. a build without this trail. */
  logExists: boolean;
  last: { agentKey: string; agentName: string } | null;
} {
  try {
    if (!existsSync(auditPath)) return { logExists: false, last: null };
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const raw = lines[index]?.trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        next?: { agentKey?: string; agentName?: string };
      };
      if (!parsed.next) continue;
      return {
        logExists: true,
        last: {
          agentKey: parsed.next.agentKey ?? "",
          agentName: parsed.next.agentName ?? "",
        },
      };
    }
    return { logExists: true, last: null };
  } catch {
    // An unreadable log is not evidence about who wrote the selection.
    return { logExists: false, last: null };
  }
}

export function saveProfileAgentSelection(
  selection: { agentKey: string; agentName: string },
  path = getDefaultProfileConfigPath()
): NoloProfileConfig | null {
  if (isProtectedHomeProfileWrite(path)) return null;
  const config = loadProfileConfig(path);
  if (!config) return null;
  const profile = config.profiles[config.currentProfile];
  if (!profile) return null;

  const agentKey = selection.agentKey.trim();
  const agentName = selection.agentName.trim();
  appendAgentSelectionAudit({
    previous: {
      ...(profile.agentKey ? { agentKey: profile.agentKey } : {}),
      ...(profile.agentName ? { agentName: profile.agentName } : {}),
    },
    next: { agentKey, agentName },
    configPath: path,
  });
  // The auto entry is represented at runtime by the built-in Nolo router key,
  // but it must not be persisted as a user-selected agent. Otherwise the next
  // process cannot distinguish "auto" from an explicit selection and stale
  // agent metadata leaks back into NOLO_AGENT on startup.
  if (!agentKey) {
    delete profile.agentKey;
    delete profile.agentName;
  } else {
    profile.agentKey = agentKey;
    profile.agentName = agentName;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}
