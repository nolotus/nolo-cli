import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  statSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  appendAgentSelectionAudit,
  buildCliRuntimeEnv,
  buildEnvFromProfile,
  clearProfileAuthToken,
  getAgentSelectionAuditPath,
  getDefaultProfileConfigPath,
  isProtectedHomeProfileWrite,
  readLastAgentSelectionAudit,
  redactArgvSecrets,
  loadProfileConfig,
  normalizeProfileServerUrl,
  saveDefaultProfile,
  saveProfileAgentSelection,
  saveProfileLocale,
} from "./profileConfig";

describe("cli profile config", () => {
  test("saves and loads the default profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-"));
    try {
      const path = join(dir, "config.json");

      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });
      const seeded = loadProfileConfig(path)!;
      seeded.profiles.default.agentKey = "agent-pub-abc";
      seeded.profiles.default.agentName = "app-builder";
      writeFileSync(path, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");

      const config = loadProfileConfig(path);
      expect(config!.currentProfile).toBe("default");
      expect(config!.profiles.default.serverUrl).toBe("https://nolo.chat");
      expect(config!.profiles.default.authToken).toBe("token-123");
      expect(buildEnvFromProfile(config!)).toEqual({
        NOLO_PROFILE: "default",
        NOLO_SERVER: "https://nolo.chat",
        AUTH_TOKEN: "token-123",
        NOLO_AGENT: "agent-pub-abc",
        NOLO_AGENT_NAME: "app-builder",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadProfileConfig normalizes legacy nolo.chat http profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-load-"));
    try {
      const path = join(dir, "config.json");
      saveDefaultProfile(path, {
        serverUrl: "http://nolo.chat",
        authToken: "token-123",
      });

      const config = loadProfileConfig(path);
      expect(config?.profiles.default.serverUrl).toBe("https://nolo.chat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalizes nolo.chat profiles to https when saving", () => {
    expect(normalizeProfileServerUrl("http://nolo.chat")).toBe("https://nolo.chat");
    expect(normalizeProfileServerUrl("http://us.nolo.chat/")).toBe("https://us.nolo.chat");
    expect(normalizeProfileServerUrl("https://nolo.chat")).toBe("https://nolo.chat");
    expect(normalizeProfileServerUrl("http://127.0.0.1:38123")).toBe("http://127.0.0.1:38123");
  });

  test("runtime env prefers explicit ambient agent over the saved profile agent", () => {
    const runtimeEnv = buildCliRuntimeEnv(
      {
        NOLO_AGENT: "agent-ambient-luna",
        NOLO_AGENT_NAME: "GPT-5.6 Luna",
      } as NodeJS.ProcessEnv,
      {
        currentProfile: "default",
        profiles: {
          default: {
            serverUrl: "https://nolo.chat",
            agentKey: "agent-profile",
            agentName: "app-builder",
          },
        },
      },
    );

    expect(runtimeEnv.NOLO_AGENT).toBe("agent-ambient-luna");
    expect(runtimeEnv.NOLO_AGENT_NAME).toBe("GPT-5.6 Luna");
  });

  test("runtime env prefers ambient AUTH_TOKEN over the saved profile token", () => {
    const runtimeEnv = buildCliRuntimeEnv(
      {
        AUTH_TOKEN: "ambient-token",
      } as NodeJS.ProcessEnv,
      {
        currentProfile: "default",
        profiles: {
          default: {
            serverUrl: "https://nolo.chat",
            authToken: "profile-token",
          },
        },
      }
    );

    expect(runtimeEnv.AUTH_TOKEN).toBe("ambient-token");
    expect(runtimeEnv.NOLO_SERVER).toBe("https://nolo.chat");
  });

  test("runtime env falls back to the saved profile token when ambient AUTH_TOKEN is unset", () => {
    const runtimeEnv = buildCliRuntimeEnv(
      {} as NodeJS.ProcessEnv,
      {
        currentProfile: "default",
        profiles: {
          default: {
            serverUrl: "https://nolo.chat",
            authToken: "profile-token",
          },
        },
      }
    );

    expect(runtimeEnv.AUTH_TOKEN).toBe("profile-token");
    expect(runtimeEnv.NOLO_SERVER).toBe("https://nolo.chat");
  });

  test("saveDefaultProfile merges login into an existing default profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-merge-"));
    try {
      const path = join(dir, "config.json");
      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-initial",
      });
      const withAgentPrefs = loadProfileConfig(path)!;
      withAgentPrefs.profiles.default.agentKey = "agent-pub-abc";
      withAgentPrefs.profiles.default.agentName = "app-builder";
      writeFileSync(path, `${JSON.stringify(withAgentPrefs, null, 2)}\n`, "utf8");

      saveDefaultProfile(path, {
        serverUrl: "https://us.nolo.chat",
        authToken: "token-next",
      });

      expect(loadProfileConfig(path)).toEqual({
        currentProfile: "default",
        profiles: {
          default: {
            serverUrl: "https://us.nolo.chat",
            authToken: "token-next",
            agentKey: "agent-pub-abc",
            agentName: "app-builder",
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clearProfileAuthToken removes only the saved auth token", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-clear-"));
    try {
      const path = join(dir, "config.json");
      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });
      const seeded = loadProfileConfig(path)!;
      seeded.profiles.default.agentKey = "agent-pub-abc";
      writeFileSync(path, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");

      expect(clearProfileAuthToken(path)).toBe(true);
      expect(loadProfileConfig(path)).toEqual({
        currentProfile: "default",
        profiles: {
          default: {
            serverUrl: "https://nolo.chat",
            agentKey: "agent-pub-abc",
          },
        },
      });
      expect(buildEnvFromProfile(loadProfileConfig(path))).toEqual({
        NOLO_PROFILE: "default",
        NOLO_SERVER: "https://nolo.chat",
        NOLO_AGENT: "agent-pub-abc",
      });
      expect(clearProfileAuthToken(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not persist auto as an explicit agent selection", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-auto-"));
    try {
      const path = join(dir, "config.json");
      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });

      saveProfileAgentSelection({ agentKey: "", agentName: "" }, path);
      let config = loadProfileConfig(path)!;
      expect(config.profiles.default.agentKey).toBeUndefined();
      expect(config.profiles.default.agentName).toBeUndefined();
      expect(buildEnvFromProfile(config)).not.toHaveProperty("NOLO_AGENT");
      expect(buildEnvFromProfile(config)).not.toHaveProperty("NOLO_AGENT_NAME");

      saveProfileAgentSelection({ agentKey: "agent-custom-auto", agentName: "auto" }, path);
      config = loadProfileConfig(path)!;
      expect(config.profiles.default.agentKey).toBe("agent-custom-auto");
      expect(config.profiles.default.agentName).toBe("auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runtime env still honors an explicit server override", () => {
    const runtimeEnv = buildCliRuntimeEnv(
      {
        NOLO_SERVER: "https://us.nolo.chat",
      } as NodeJS.ProcessEnv,
      {
        currentProfile: "default",
        profiles: {
          default: {
            serverUrl: "https://nolo.chat",
            authToken: "profile-token",
          },
        },
      }
    );

    expect(runtimeEnv.AUTH_TOKEN).toBe("profile-token");
    expect(runtimeEnv.NOLO_SERVER).toBe("https://us.nolo.chat");
    expect(runtimeEnv.BASE_URL).toBe("https://us.nolo.chat");
  });

  test("getDefaultProfileConfigPath honors NOLO_HOME so tests never touch ~/.nolo", () => {
    const prev = process.env.NOLO_HOME;
    try {
      process.env.NOLO_HOME = "/tmp/nolo-isolated-home";
      expect(getDefaultProfileConfigPath()).toBe("/tmp/nolo-isolated-home/config.json");
    } finally {
      if (prev === undefined) delete process.env.NOLO_HOME;
      else process.env.NOLO_HOME = prev;
    }
  });
});

describe("agent selection audit trail", () => {
  test("every write records previous → next plus the writing process", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-audit-"));
    try {
      const path = join(dir, "config.json");
      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });

      saveProfileAgentSelection(
        { agentKey: "agent-pub-app-builder", agentName: "应用构建助手" },
        path,
      );
      saveProfileAgentSelection({ agentKey: "", agentName: "" }, path);

      const entries = readFileSync(getAgentSelectionAuditPath(path), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(entries).toHaveLength(2);
      // The write that pins a non-default agent must name what it replaced,
      // so a surprise selection can be traced back to the session that made it.
      expect(entries[0].previous).toEqual({});
      expect(entries[0].next).toEqual({
        agentKey: "agent-pub-app-builder",
        agentName: "应用构建助手",
      });
      expect(entries[1].previous).toEqual({
        agentKey: "agent-pub-app-builder",
        agentName: "应用构建助手",
      });
      expect(entries[1].next).toEqual({ agentKey: "", agentName: "" });
      // Process identity is the point of the log: which binary wrote this.
      expect(entries[0].pid).toBe(process.pid);
      expect(entries[0].execPath).toBe(process.execPath);
      expect(Array.isArray(entries[0].argv)).toBe(true);
      expect(entries[0].stack.length).toBeGreaterThan(0);
      expect(typeof entries[0].at).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("audit lives beside the config it describes, and never blocks the write", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-audit-path-"));
    try {
      const path = join(dir, "config.json");
      expect(getAgentSelectionAuditPath(path)).toBe(
        join(dir, "agent-selection.log"),
      );

      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });
      // An unwritable audit path must not cost the user their switch.
      appendAgentSelectionAudit(
        {
          previous: {},
          next: { agentKey: "a", agentName: "b" },
          configPath: path,
        },
        join(dir, "missing-dir\0invalid", "audit.log"),
      );
      const config = saveProfileAgentSelection(
        { agentKey: "agent-pub-x", agentName: "x" },
        path,
      );
      expect(config!.profiles.default.agentKey).toBe("agent-pub-x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startup agent origin", () => {
  const profileWithAgent = {
    currentProfile: "default",
    profiles: {
      default: {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
        agentKey: "agent-pub-app-builder",
        agentName: "应用构建助手",
      },
    },
  };

  test("marks a profile-restored agent so the TUI can say where it came from", () => {
    const env = buildCliRuntimeEnv({} as NodeJS.ProcessEnv, profileWithAgent);
    expect(env.NOLO_AGENT).toBe("agent-pub-app-builder");
    expect(env.NOLO_AGENT_SOURCE).toBe("profile");
  });

  test("an explicit shell agent is reported as such, not as a saved choice", () => {
    const env = buildCliRuntimeEnv(
      { NOLO_AGENT: "agent-pub-shell" } as NodeJS.ProcessEnv,
      profileWithAgent,
    );
    expect(env.NOLO_AGENT).toBe("agent-pub-shell");
    expect(env.NOLO_AGENT_SOURCE).toBe("env");
  });

  test("no saved selection leaves no origin to explain", () => {
    const env = buildCliRuntimeEnv({} as NodeJS.ProcessEnv, {
      currentProfile: "default",
      profiles: { default: { serverUrl: "https://nolo.chat" } },
    });
    expect(env.NOLO_AGENT).toBeUndefined();
    expect(env.NOLO_AGENT_SOURCE).toBeUndefined();
  });
});

describe("test processes cannot rewrite the developer's own profile", () => {
  // Regression: TUI tests drive the real workspace loop, so a test that typed
  // /agent <key> persisted through the real seam and pinned the developer's
  // startup agent in ~/.nolo/config.json — rediscovered by hand every time.
  const realHomeConfig = join(homedir(), ".nolo", "config.json");

  test("a write aimed at the real home config is refused under bun test", () => {
    expect(process.env.NODE_ENV).toBe("test");
    // The suite-wide preload gives this process its own home...
    expect(process.env.NOLO_HOME).toBeTruthy();
    expect(process.env.NOLO_HOME).not.toBe(join(homedir(), ".nolo"));
    // ...and the real config stays refused even so, for anyone running a test
    // file without the preload or passing the real path explicitly.
    expect(isProtectedHomeProfileWrite(realHomeConfig)).toBe(true);

    const before = existsSync(realHomeConfig)
      ? readFileSync(realHomeConfig, "utf8")
      : null;
    expect(
      saveProfileAgentSelection(
        { agentKey: "agent-pub-01APPBUILDER00000001YAII3I", agentName: "应用构建助手" },
        realHomeConfig,
      ),
    ).toBeNull();
    expect(saveProfileLocale("en", realHomeConfig)).toBeNull();
    const after = existsSync(realHomeConfig)
      ? readFileSync(realHomeConfig, "utf8")
      : null;
    expect(after).toBe(before);
  });

  test("temp paths and NOLO_HOME stay writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-guard-"));
    try {
      const path = join(dir, "config.json");
      expect(isProtectedHomeProfileWrite(path)).toBe(false);

      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });
      const config = saveProfileAgentSelection(
        { agentKey: "agent-pub-x", agentName: "x" },
        path,
      );
      expect(config!.profiles.default.agentKey).toBe("agent-pub-x");

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit log never records a credential", () => {
  // The log exists to be read and pasted around while debugging, and
  // `nolo login --token <auth-token>` puts a live credential in argv.
  test("masks secret flag values in both --flag value and --flag=value form", () => {
    expect(
      redactArgvSecrets(["bun", "index.ts", "login", "--token", "secret-abc"]),
    ).toEqual(["bun", "index.ts", "login", "--token", "[REDACTED]"]);
    expect(redactArgvSecrets(["nolo", "--api-key=sk-live-123"])).toEqual([
      "nolo",
      "--api-key=[REDACTED]",
    ]);
    expect(
      redactArgvSecrets(["nolo", "machine", "--machine-key", "mk-1", "--json"]),
    ).toEqual(["nolo", "machine", "--machine-key", "[REDACTED]", "--json"]);
  });

  test("leaves non-secret flags that merely look like keys alone", () => {
    // --row-dbkey is a record address, not a credential; masking it would
    // destroy the attribution this log exists to provide.
    expect(
      redactArgvSecrets(["nolo", "table", "--row-dbkey", "row-123", "--limit", "5"]),
    ).toEqual(["nolo", "table", "--row-dbkey", "row-123", "--limit", "5"]);
  });

  test("the written audit line carries the redacted argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-redact-"));
    try {
      const path = join(dir, "config.json");
      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });
      const originalArgv = process.argv;
      process.argv = ["bun", "index.ts", "login", "--token", "super-secret"];
      try {
        saveProfileAgentSelection(
          { agentKey: "agent-pub-x", agentName: "x" },
          path,
        );
      } finally {
        process.argv = originalArgv;
      }
      const raw = readFileSync(getAgentSelectionAuditPath(path), "utf8");
      expect(raw).not.toContain("super-secret");
      expect(JSON.parse(raw.trim()).argv).toEqual([
        "bun",
        "index.ts",
        "login",
        "--token",
        "[REDACTED]",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("guard covers every writer, and rotation keeps attribution", () => {
  test("the real profile is refused by the auth-token and login writers too", () => {
    const realHomeConfig = join(homedir(), ".nolo", "config.json");
    const before = existsSync(realHomeConfig)
      ? readFileSync(realHomeConfig, "utf8")
      : null;
    expect(clearProfileAuthToken(realHomeConfig)).toBe(false);
    // login must fail loudly rather than silently skip: a test aimed here is a bug.
    expect(() =>
      saveDefaultProfile(realHomeConfig, {
        serverUrl: "https://nolo.chat",
        authToken: "should-never-land",
      }),
    ).toThrow(/Refusing to write/);
    const after = existsSync(realHomeConfig)
      ? readFileSync(realHomeConfig, "utf8")
      : null;
    expect(after).toBe(before);
  });

  test("rotation keeps the newest entries instead of emptying the log", () => {
    const dir = mkdtempSync(join(tmpdir(), "nolo-profile-rotate-"));
    try {
      const path = join(dir, "config.json");
      const auditPath = getAgentSelectionAuditPath(path);
      saveDefaultProfile(path, {
        serverUrl: "https://nolo.chat",
        authToken: "token-123",
      });
      // Push the log past the rotation threshold with junk entries.
      const filler = `${JSON.stringify({ next: { agentKey: "old", agentName: "old" }, pad: "x".repeat(2048) })}\n`;
      writeFileSync(auditPath, filler.repeat(300), "utf8");

      saveProfileAgentSelection(
        { agentKey: "agent-pub-newest", agentName: "newest" },
        path,
      );

      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      expect(lines.length).toBeLessThan(300);
      // Attribution for the current selection survives — an emptied log would
      // make it look like a build without the audit trail wrote it.
      expect(readLastAgentSelectionAudit(auditPath)).toEqual({
        logExists: true,
        last: { agentKey: "agent-pub-newest", agentName: "newest" },
      });
      expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
