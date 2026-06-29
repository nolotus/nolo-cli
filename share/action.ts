import type { AppThunkApi } from "../app/store";
import { selectCurrentUser, selectUserId } from "../auth/authSlice";
import {
  selectCurrentServer,
  selectRemoteServers,
} from "../app/settings/settingSlice";
import { normalizeTimeFields } from "../database/actions/common";
import { createUserKey } from "../database/keys";
import { noloDeleteRequest, noloWriteRequest } from "../database/requests";

import type { SharedObject, ShareType } from "./types";
import { shareKey } from "./keys";
import {
  toNonEmptyString,
  sanitizeShareData,
  extractCoverImage,
  extractAgentInfo,
  resolveShareAuthorIdentity,
} from "./helpers";

const generateToken = (): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const charsLen = chars.length; // 36
  const maxValid = 252; // 252 = 36 * 7, largest multiple of 36 ≤ 255
  let token = "";
  while (token.length < 10) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && token.length < 10; i++) {
      if (bytes[i] < maxValid) {
        token += chars.charAt(bytes[i] % charsLen);
      }
    }
  }
  return token;
};

export interface ShareActionConfig {
  type: ShareType;
  data: Record<string, unknown>;
  title: string;
  description?: string;
  visibility?: "private" | "community";
}

const assertDialogShareMessagesPresent = (
  type: ShareType,
  data: Record<string, unknown>
) => {
  if (type !== "dialog") return;
  const messages = Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(data.history)
      ? data.history
      : [];
  if (messages.length > 0) return;
  throw new Error("Cannot share dialog without persisted messages.");
};

const resolveTableSharePayload = (
  type: ShareType,
  data: Record<string, unknown>,
  userId: string,
  originServer: string
): Record<string, unknown> => {
  if (type !== "table") return sanitizeShareData(data);

  const tableDbKey =
    typeof data.dbKey === "string" && data.dbKey.trim().length > 0
      ? data.dbKey
      : undefined;
  const tableOwnerId =
    typeof data.tenantId === "string" && data.tenantId.trim().length > 0
      ? data.tenantId
      : userId;

  if (!tableDbKey) {
    throw new Error("Table share requires a dbKey.");
  }

  return {
    mode: "live",
    tableDbKey,
    tableOwnerId,
    originServer,
  };
};

export const shareResourceAction = async (
  config: ShareActionConfig,
  thunkApi: AppThunkApi
): Promise<{ token: string; key: string }> => {
  const state = thunkApi.getState();
  const userId = selectUserId(state);
  const currentUser = selectCurrentUser(state);

  if (!userId) {
    throw new Error("User must be logged in to share resources.");
  }

  const token = generateToken();
  const key = shareKey.create(token);

  const currentServer = selectCurrentServer(state);
  assertDialogShareMessagesPresent(config.type, config.data);
  const snapshotData = resolveTableSharePayload(
    config.type,
    config.data,
    userId,
    currentServer
  );
  const coverImage = extractCoverImage(config.type, snapshotData);
  const agentInfo = extractAgentInfo(config.type, snapshotData);
  const createdAt = Date.now();
  const { db: clientDb } = thunkApi.extra;
  let authorProfile: Record<string, unknown> | null = null;

  if (clientDb) {
    try {
      authorProfile = await clientDb.get(createUserKey.profile(userId));
    } catch {
      authorProfile = null;
    }
  }

  const { authorName, authorAvatar } = resolveShareAuthorIdentity({
    user: currentUser as Record<string, unknown> | null,
    profile: authorProfile,
  });

  // Resolve agent name from local DB if we have a key but no name
  if (agentInfo.sourceAgentKey && !agentInfo.sourceAgentName) {
    if (clientDb) {
      try {
        const agentData = await clientDb.get(agentInfo.sourceAgentKey);
        const name = toNonEmptyString(agentData?.name);
        if (name) agentInfo.sourceAgentName = name;
      } catch { /* agent lookup is best-effort */ }
    }
  }

  const sharedObject: SharedObject = {
    type: config.type,
    version: 1,
    data: snapshotData,
    meta: {
      authorId: userId,
      ...(authorName ? { authorName } : {}),
      ...(authorAvatar ? { authorAvatar } : {}),
      createdAt,
      visibility: config.visibility ?? "private",
      title: config.title,
      description: config.description,
      originalId: (config.data.dbKey ?? config.data.id) as string | undefined,
      coverImage,
      ...agentInfo,
    },
  };

  const servers = [
    currentServer,
    ...selectRemoteServers(state).filter((server) => server !== currentServer),
  ].filter(Boolean);
  const replicaServers = servers.filter((server) => server !== currentServer);

  if (servers.length === 0) {
    throw new Error("No available server to publish share.");
  }

  if (config.type === "table" && sharedObject.data.mode === "live") {
    sharedObject.data = {
      ...sharedObject.data,
      originServer: currentServer,
    };
    sharedObject.meta = {
      ...sharedObject.meta,
      mode: "live",
      tableDbKey:
        typeof sharedObject.data.tableDbKey === "string"
          ? sharedObject.data.tableDbKey
          : undefined,
      tableOwnerId:
        typeof sharedObject.data.tableOwnerId === "string"
          ? sharedObject.data.tableOwnerId
          : undefined,
      originServer: currentServer,
      replicaServers,
    };
  }

  const persistedSharedObject = normalizeTimeFields({
    ...sharedObject,
    dbKey: key,
    userId,
  });

  // Compute index keys on the frontend — server just stores them
  const indexKeys = shareKey.allIndexKeysFromShare(key, persistedSharedObject);

  const results = await Promise.all(
    servers.map((server) =>
      noloWriteRequest(server, { data: persistedSharedObject, customKey: key, userId, indexKeys }, state)
    )
  );
  const [originPublished, ...replicaPublishResults] = results;

  if (!originPublished) {
    const successfulReplicaServers = replicaServers.filter(
      (_, index) => replicaPublishResults[index]
    );
    await Promise.all(
      successfulReplicaServers.map((server) =>
        noloDeleteRequest(server, key, { type: "single" }, state)
      )
    );
    throw new Error("Failed to publish share to origin server.");
  }

  if (!clientDb) {
    throw new Error("Client database instance is required in shareResourceAction");
  }
  await clientDb.put(key, persistedSharedObject);

  return { token, key };
};
