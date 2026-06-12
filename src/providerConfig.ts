export type ByokProvider =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "codex-cli"
  | "qoder"
  | "custom";

export type ByokProviderConfig = {
  provider: ByokProvider;
  auth: {
    kind: "env";
    envVar: string;
  };
  baseUrl?: string;
  localOnly: true;
  requiresNoloAuth: false;
};

type CreateByokProviderConfigInput = {
  provider: ByokProvider;
  credentialEnvVar: string;
  baseUrl?: string;
};

const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RAW_KEY_PATTERNS = [
  /^sk-/i,
  /^sk_/i,
  /^ghp_/i,
  /^xox[baprs]-/i,
  /^eyJ/i,
];

function assertEnvVarReference(value: string) {
  if (RAW_KEY_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("credentialEnvVar must be an environment variable name, not a raw key");
  }
  if (!ENV_VAR_PATTERN.test(value)) {
    throw new Error("credentialEnvVar must be an uppercase environment variable name");
  }
}

export function createByokProviderConfig(
  input: CreateByokProviderConfigInput
): ByokProviderConfig {
  assertEnvVarReference(input.credentialEnvVar);

  return {
    provider: input.provider,
    auth: {
      kind: "env",
      envVar: input.credentialEnvVar,
    },
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    localOnly: true,
    requiresNoloAuth: false,
  };
}

export function describeProviderCredentialBoundary(provider: ByokProvider) {
  return [
    "Provider credentials are read from local environment variables or local CLI sessions.",
    "No Nolo account token is required for repository-local runs.",
    "Do not paste provider keys, account tokens, or private logs into public issues.",
    "Remote synced workflows may require separate Nolo authentication and should document that boundary.",
    `Provider: ${provider}.`,
  ];
}
