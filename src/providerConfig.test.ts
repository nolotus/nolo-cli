import { describe, expect, test } from "bun:test";

import {
  createByokProviderConfig,
  describeProviderCredentialBoundary,
} from "./providerConfig";

describe("public BYOK provider config boundary", () => {
  test("creates OpenAI config from an environment variable reference without storing the key", () => {
    expect(createByokProviderConfig({
      provider: "openai",
      credentialEnvVar: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
    })).toEqual({
      provider: "openai",
      auth: {
        kind: "env",
        envVar: "OPENAI_API_KEY",
      },
      baseUrl: "https://api.openai.com/v1",
      localOnly: true,
      requiresNoloAuth: false,
    });
  });

  test("rejects raw API-key-looking credential values", () => {
    expect(() => createByokProviderConfig({
      provider: "openai",
      credentialEnvVar: "sk-proj-raw-secret",
    })).toThrow("credentialEnvVar must be an environment variable name, not a raw key");
  });

  test("describes local credential and remote workflow boundaries", () => {
    expect(describeProviderCredentialBoundary("openrouter")).toEqual([
      "Provider credentials are read from local environment variables or local CLI sessions.",
      "No Nolo account token is required for repository-local runs.",
      "Do not paste provider keys, account tokens, or private logs into public issues.",
      "Remote synced workflows may require separate Nolo authentication and should document that boundary.",
      "Provider: openrouter.",
    ]);
  });
});
