export const DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOLS = [
  "listDialogs",
  "readDialog",
  "listAgents",
  "readAgent",
  "listSpaces",
  "readSpace",
  "readDoc",
  "readSkillDoc",
  "listTables",
  "queryTableRows",
  "cliWhoami",
  "cliDoctor",
] as const;

export type RuntimeToolSurfaceHost =
  | "web"
  | "cli"
  | "desktop"
  | "connector"
  | "server";

export type RuntimeToolSurfaceVisibility =
  | "private"
  | "public"
  | "anonymous"
  | "shared";

export type RuntimeToolSurfaceInput = {
  explicitToolNames?: string[] | null;
  currentUserId?: string | null;
  agentOwnerId?: string | null;
  invocationVisibility?: RuntimeToolSurfaceVisibility;
  runtimeHost: RuntimeToolSurfaceHost;
  trustedPrivateInvocation?: boolean;
};

export type RuntimeToolSurfaceResult = {
  explicitToolNames: string[];
  injectedToolNames: string[];
  finalToolNames: string[];
  auditReason:
    | "private-authenticated-defaults"
    | "explicit-only-public"
    | "explicit-only-anonymous"
    | "explicit-only-shared"
    | "explicit-only-missing-identity"
    | "explicit-only-owner-mismatch";
};

export type RuntimeToolSurfaceForAgentInput = {
  explicitToolNames?: string[] | null;
  currentUserId?: string | null;
  agentOwnerId?: string | null;
  agentKey?: string | null;
  isPublic?: boolean | null;
  sharingLevel?: string | null;
  runtimeHost: RuntimeToolSurfaceHost;
  trustedPrivateInvocation?: boolean;
};

function uniqueToolNames(values: readonly string[]) {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function canInjectPrivateDefaults(args: RuntimeToolSurfaceInput) {
  if (!args.currentUserId) return false;
  if (args.invocationVisibility !== "private") return false;
  if (args.agentOwnerId && args.agentOwnerId === args.currentUserId) return true;
  if (args.trustedPrivateInvocation === true) return true;
  return false;
}

function explicitOnlyReason(
  args: RuntimeToolSurfaceInput
): RuntimeToolSurfaceResult["auditReason"] {
  if (!args.currentUserId || !args.agentOwnerId) {
    return "explicit-only-missing-identity";
  }
  if (args.invocationVisibility === "public") return "explicit-only-public";
  if (args.invocationVisibility === "shared") return "explicit-only-shared";
  if (args.agentOwnerId !== args.currentUserId) {
    return "explicit-only-owner-mismatch";
  }
  return "explicit-only-anonymous";
}

export function resolveRuntimeToolSurface(
  args: RuntimeToolSurfaceInput
): RuntimeToolSurfaceResult {
  const explicitToolNames = uniqueToolNames(args.explicitToolNames ?? []);

  if (canInjectPrivateDefaults(args)) {
    const injectedToolNames = [...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOLS];
    return {
      explicitToolNames,
      injectedToolNames,
      finalToolNames: uniqueToolNames([
        ...explicitToolNames,
        ...injectedToolNames,
      ]),
      auditReason: "private-authenticated-defaults",
    };
  }

  return {
    explicitToolNames,
    injectedToolNames: [],
    finalToolNames: explicitToolNames,
    auditReason: explicitOnlyReason(args),
  };
}

export function isPublicRuntimeAgentRef(value: unknown) {
  return (
    typeof value === "string" &&
    (value.startsWith("agent-pub-") || value.startsWith("cybot-pub-"))
  );
}

export function inferOwnerIdFromRuntimeAgentKey(value: unknown) {
  if (typeof value !== "string") return null;
  const privateAgentMatch = value.match(/^agent-([^-]+)-(.+)$/);
  if (privateAgentMatch && privateAgentMatch[1] !== "pub") {
    return privateAgentMatch[1];
  }
  const privateCybotMatch = value.match(/^cybot-([^-]+)-(.+)$/);
  if (privateCybotMatch && privateCybotMatch[1] !== "pub") {
    return privateCybotMatch[1];
  }
  return null;
}

export function resolveRuntimeToolSurfaceForAgent(
  args: RuntimeToolSurfaceForAgentInput
) {
  const agentKey = typeof args.agentKey === "string" ? args.agentKey : "";
  const currentUserId = typeof args.currentUserId === "string" ? args.currentUserId : "";
  const inferredOwnerId =
    args.agentOwnerId ??
    (currentUserId &&
    (agentKey.startsWith(`agent-${currentUserId}-`) ||
      agentKey.startsWith(`cybot-${currentUserId}-`))
      ? currentUserId
      : inferOwnerIdFromRuntimeAgentKey(agentKey));
  const publicRef = isPublicRuntimeAgentRef(agentKey);
  const visibility =
    args.trustedPrivateInvocation === true
      ? "private"
      : publicRef || args.isPublic === true || args.sharingLevel === "public"
      ? "public"
      : "private";
  return resolveRuntimeToolSurface({
    explicitToolNames: args.explicitToolNames,
    currentUserId: args.currentUserId,
    agentOwnerId: inferredOwnerId,
    invocationVisibility: visibility,
    runtimeHost: args.runtimeHost,
    trustedPrivateInvocation: args.trustedPrivateInvocation,
  });
}

const SECRET_FIELD_NAMES = [
  "apikey",
  "api_key",
  "secret",
  "token",
  "authorization",
  "credential",
  "password",
];

function isSecretFieldName(key: string) {
  const normalized = key.toLowerCase();
  return SECRET_FIELD_NAMES.some((name) => normalized.includes(name));
}

export function redactAgentRecordForWorkspaceTool(record: unknown): unknown {
  if (!record || typeof record !== "object") return record;
  if (Array.isArray(record)) return record.map(redactAgentRecordForWorkspaceTool);
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (isSecretFieldName(key)) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = value && typeof value === "object"
      ? redactAgentRecordForWorkspaceTool(value)
      : value;
  }
  return redacted;
}
