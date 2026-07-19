import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCliRuntimeEnv,
  buildEnvFromProfile,
  clearProfileAuthToken,
  loadProfileConfig,
  normalizeProfileServerUrl,
  saveDefaultProfile,
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
});
