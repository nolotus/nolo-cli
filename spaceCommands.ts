import { MemberRole, SpaceVisibility, ContentType } from "./app/types";
import { authRoutes } from "./auth/routes";
import { DataType } from "./create/types";
import { createSpaceKey, normalizeSpaceId } from "./create/space/spaceKeys";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerUrl,
  resolveServerCandidates,
} from "./cliEnvHelpers";
import { readDbRecord, writeAgentRecord } from "./agentRecordHelpers";
import { readLiveDbRecordAfterTombstoneMerge } from "./globalRecordOperations";
import { ulid } from "ulid";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { resolveFileCategory } from "./app/utils/fileUtils";

type SpaceCommandDeps = {
  env: NodeJS.ProcessEnv;
  output?: { write(chunk: string): unknown };
  fetchImpl?: typeof fetch;
};

const VALID_INVITE_ROLES = new Set<string>([
  MemberRole.ADMIN,
  MemberRole.MEMBER,
  MemberRole.GUEST,
]);

function hasHelpArg(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function writeOutput(deps: SpaceCommandDeps, text: string) {
  (deps.output ?? process.stdout).write(text);
}

function requireTokenUser(args: string[], env: NodeJS.ProcessEnv) {
  const authToken = resolveAuthToken(args, env);
  const userId = parseUserIdFromAuthToken(authToken) || env.USER_ID || "";
  if (!authToken) {
    throw new Error("space command requires an auth token. Pass --token or set AUTH_TOKEN.");
  }
  if (!userId) {
    throw new Error("auth token does not contain userId. Pass a user-scoped token.");
  }
  return { authToken, userId };
}

function printCreateUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo space create --name <name> [--description <text>] [--id <spaceId>]

Options:
  --visibility private|public  Defaults to private.
  --public                     Shortcut for --visibility public.
  --server <url>               Default write target.
  --token <jwt>                Auth token. Required for writes.
  --json                       Print machine-readable JSON.
`);
}

function printInviteUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo space invite --space <spaceId> --member <userId> [--role member|admin|guest]

Options:
  --server <url>               Default write target.
  --token <jwt>                Auth token. Required for writes.
  --json                       Print machine-readable JSON.

Note:
  Use --member for an existing Nolo user id, or --email to send a pending
  space invitation email.
`);
}

function printAcceptInviteUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo space accept-invite --invite <inviteToken>

Options:
  --server <url>               Default API target.
  --token <jwt>                Auth token. Required for accepting.
  --invite <inviteToken>       Space invite token from the email link.
  --space-invite <inviteToken> Alias for --invite.
  --json                       Print machine-readable JSON.
`);
}

function printUploadUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo space upload --space <spaceId> --file <path>

Options:
  --server <url>               Default API target.
  --token <jwt>                Auth token. Required for writes.
  --json                       Print machine-readable JSON.

Note:
  Currently only YAML files (.yaml, .yml) are supported.
`);
}

async function writeDbRecord(args: {
  authToken: string;
  dbKey: string;
  fetchImpl: typeof fetch;
  record: Record<string, any>;
  serverUrl: string;
  userId: string;
}) {
  await writeAgentRecord({
    agentKey: args.dbKey,
    authToken: args.authToken,
    fetchImpl: args.fetchImpl,
    serverUrl: args.serverUrl,
    userId: args.userId,
    record: args.record,
  });
}

export async function runSpaceCreateCommand(
  args: string[],
  deps: SpaceCommandDeps,
): Promise<number> {
  if (hasHelpArg(args)) {
    printCreateUsage(deps.output ?? process.stdout);
    return 0;
  }

  const name = readOption(args, "--name") ?? args.find((value) => !value.startsWith("-"));
  if (!name?.trim()) {
    throw new Error("space create requires --name <name>.");
  }

  const { authToken, userId } = requireTokenUser(args, deps.env);
  const serverUrl = resolveServerUrl(args, deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spaceId = normalizeSpaceId(readOption(args, "--id") ?? ulid());
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const visibilityRaw = readOption(args, "--visibility");
  const visibility = hasFlag(args, "--public") || visibilityRaw === SpaceVisibility.PUBLIC
    ? SpaceVisibility.PUBLIC
    : SpaceVisibility.PRIVATE;
  const description = readOption(args, "--description") ?? "";
  const spaceKey = createSpaceKey.space(spaceId);
  const memberKey = createSpaceKey.member(userId, spaceId);

  const spaceRecord = {
    id: spaceId,
    dbKey: spaceKey,
    type: DataType.SPACE,
    name: name.trim(),
    description,
    ownerId: userId,
    visibility,
    members: [userId],
    categories: {},
    contents: {},
    createdAt: now,
    updatedAt: now,
  };
  const memberRecord = {
    dbKey: memberKey,
    type: DataType.SPACE,
    userId,
    role: MemberRole.OWNER,
    joinedAt: now,
    spaceId,
    spaceName: name.trim(),
    ownerId: userId,
    visibility,
    createdAt: nowISO,
    updatedAt: nowISO,
    spaceCreatedAt: now,
    spaceUpdatedAt: now,
  };

  await writeDbRecord({ authToken, dbKey: spaceKey, fetchImpl, record: spaceRecord, serverUrl, userId });
  await writeDbRecord({ authToken, dbKey: memberKey, fetchImpl, record: memberRecord, serverUrl, userId });

  const result = { spaceId, spaceKey, memberKey, name: name.trim(), visibility, serverUrl };
  if (hasFlag(args, "--json")) {
    writeOutput(deps, `${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeOutput(deps, `Created space ${spaceId} (${name.trim()})\n`);
  }
  return 0;
}

export async function runSpaceInviteCommand(
  args: string[],
  deps: SpaceCommandDeps,
): Promise<number> {
  if (hasHelpArg(args)) {
    printInviteUsage(deps.output ?? process.stdout);
    return 0;
  }

  const spaceIdRaw = readOption(args, "--space") ?? readOption(args, "--space-id");
  const email = readOption(args, "--email");
  const memberId = readOption(args, "--member") ?? readOption(args, "--member-id");
  if (!spaceIdRaw?.trim()) throw new Error("space invite requires --space <spaceId>.");
  if (!memberId?.trim() && !email?.trim()) {
    throw new Error("space invite requires --member <userId> or --email <address>.");
  }

  const role = readOption(args, "--role") ?? MemberRole.MEMBER;
  if (!VALID_INVITE_ROLES.has(role)) {
    throw new Error("--role must be one of member, admin, or guest.");
  }

  const { authToken, userId } = requireTokenUser(args, deps.env);
  const serverUrl = resolveServerUrl(args, deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spaceId = normalizeSpaceId(spaceIdRaw);

  if (email?.trim()) {
    const response = await fetchImpl(`${serverUrl}${authRoutes.users.spaceInvite.path}`, {
      method: authRoutes.users.spaceInvite.method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spaceId,
        email: email.trim(),
        role,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data?.error?.message || data?.error || `space invite failed: HTTP ${response.status}`,
      );
    }
    if (hasFlag(args, "--json")) {
      writeOutput(deps, `${JSON.stringify(data, null, 2)}\n`);
    } else {
      writeOutput(deps, `Invited ${email.trim()} to space ${spaceId} as ${role}\n`);
    }
    return 0;
  }

  const spaceKey = createSpaceKey.space(spaceId);
  const spaceRecord = await readDbRecord({
    dbKey: spaceKey,
    authToken,
    fetchImpl,
    serverUrl,
  });

  const members = Array.isArray(spaceRecord?.members) ? spaceRecord.members : [];
  if (!members.includes(userId)) {
    throw new Error("current user is not a member of this space.");
  }
  if (members.includes(memberId)) {
    throw new Error("member already exists in this space.");
  }

  const now = Date.now();
  const updatedSpaceRecord = {
    ...spaceRecord,
    members: [...members, memberId],
    updatedAt: now,
  };
  const memberKey = createSpaceKey.member(memberId, spaceId);
  const memberRecord = {
    dbKey: memberKey,
    type: DataType.SPACE,
    userId: memberId,
    role,
    joinedAt: now,
    updatedAt: now,
    spaceId,
    spaceName: spaceRecord.name ?? spaceId,
    ownerId: spaceRecord.ownerId,
    visibility: spaceRecord.visibility ?? SpaceVisibility.PRIVATE,
    spaceCreatedAt: spaceRecord.createdAt,
    spaceUpdatedAt: now,
  };

  await writeDbRecord({ authToken, dbKey: spaceKey, fetchImpl, record: updatedSpaceRecord, serverUrl, userId });
  await writeDbRecord({ authToken, dbKey: memberKey, fetchImpl, record: memberRecord, serverUrl, userId });

  const result = { spaceId, spaceKey, memberKey, memberId, role, serverUrl };
  if (hasFlag(args, "--json")) {
    writeOutput(deps, `${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeOutput(deps, `Invited ${memberId} to space ${spaceId} as ${role}\n`);
  }
  return 0;
}

export async function runSpaceAcceptInviteCommand(
  args: string[],
  deps: SpaceCommandDeps,
): Promise<number> {
  if (hasHelpArg(args)) {
    printAcceptInviteUsage(deps.output ?? process.stdout);
    return 0;
  }

  const inviteToken =
    readOption(args, "--invite") ??
    readOption(args, "--space-invite") ??
    readOption(args, "--invite-token");
  if (!inviteToken?.trim()) {
    throw new Error("space accept-invite requires --invite <inviteToken>.");
  }

  const { authToken } = requireTokenUser(args, deps.env);
  const serverUrl = resolveServerUrl(args, deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${serverUrl}${authRoutes.users.spaceInviteAccept.path}`, {
    method: authRoutes.users.spaceInviteAccept.method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token: inviteToken.trim(),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message || data?.error || `space invite accept failed: HTTP ${response.status}`,
    );
  }

  if (hasFlag(args, "--json")) {
    writeOutput(deps, `${JSON.stringify(data, null, 2)}\n`);
  } else {
    writeOutput(deps, `Accepted invite for space ${data?.spaceId ?? ""}\n`);
  }
  return 0;
}

export async function runSpaceUploadCommand(
  args: string[],
  deps: SpaceCommandDeps,
): Promise<number> {
  if (hasHelpArg(args)) {
    printUploadUsage(deps.output ?? process.stdout);
    return 0;
  }

  const spaceIdRaw = readOption(args, "--space") ?? readOption(args, "--space-id");
  const filePath = readOption(args, "--file");
  if (!spaceIdRaw?.trim()) throw new Error("space upload requires --space <spaceId>.");
  if (!filePath?.trim()) throw new Error("space upload requires --file <path>.");

  const ext = extname(filePath).toLowerCase();
  if (ext !== ".yaml" && ext !== ".yml") {
    throw new Error("Only YAML files (.yaml, .yml) are supported for space upload.");
  }

  const { authToken, userId } = requireTokenUser(args, deps.env);
  const serverUrl = resolveServerUrl(args, deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spaceId = normalizeSpaceId(spaceIdRaw);

  const fileContent = readFileSync(filePath);
  const spaceKey = createSpaceKey.space(spaceId);
  const uploadName = basename(filePath);
  const mimeType = "application/yaml";
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const { record: spaceRecord } = await readLiveDbRecordAfterTombstoneMerge({
    dbKey: spaceKey,
    authToken,
    fetchImpl,
    serverUrls: resolveServerCandidates(args, deps.env, serverUrl),
  });

  const formData = new FormData();
  formData.append("file", new Blob([fileContent], { type: mimeType }), uploadName);
  
  const fileId = ulid();
  const fileDbKey = `file-${userId}-${fileId}`;
  formData.append("metadata", JSON.stringify({
    id: fileId,
    title: uploadName,
    originalName: uploadName,
    fileName: `${fileId}${ext}`,
    filePath: "",
    size: fileContent.length,
    mimeType,
    type: DataType.FILE,
    fileCategory: resolveFileCategory({
      mimeType,
      fileName: uploadName,
    }),
    dbKey: fileDbKey,
    userId,
    ownerType: "space",
    ownerId: spaceId,
    ownerDbKey: spaceKey,
    source: "cli-space-upload",
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
  formData.append("customKey", fileDbKey);
  formData.append("userId", userId);
  formData.append("ownerType", "space");
  formData.append("ownerId", spaceId);

  const uploadRes = await fetchImpl(`${serverUrl}/api/v1/db/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    body: formData,
  });

  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    throw new Error(
      uploadData?.error?.message || uploadData?.error || `space upload failed: HTTP ${uploadRes.status}`
    );
  }

  const contents = spaceRecord.contents || {};
  contents[fileDbKey] = {
    ...(contents[fileDbKey] ?? {}),
    title: uploadName,
    type: ContentType.FILE,
    contentKey: fileDbKey,
    createdAt: contents[fileDbKey]?.createdAt ?? now,
    updatedAt: now,
  };

  await writeDbRecord({
    authToken,
    dbKey: spaceKey,
    fetchImpl,
    record: { ...spaceRecord, contents, updatedAt: now },
    serverUrl,
    userId,
  });

  if (hasFlag(args, "--json")) {
    writeOutput(deps, `${JSON.stringify({ ...uploadData, spaceId, spaceKey }, null, 2)}\n`);
  } else {
    writeOutput(deps, `Uploaded ${uploadName} to space ${spaceId} (fileId: ${fileId})\n`);
  }

  return 0;
}
