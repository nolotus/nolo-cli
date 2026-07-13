import { getAllServers } from "./common";
import {
  noloDeleteRequest,
  noloPatchRequest,
  noloUploadRequest,
  noloWriteRequest,
  syncWithServers,
} from "../requests";
import { planServersForTenant } from "../tenantPlacement";
import {
  isDeviceLocalDbKey,
  isDeviceLocalOwnerId,
} from "../authority/deviceLocal";
import { resolveRecordAuthority } from "../authority/recordAuthority";
import { planAuthorityReadServers } from "./readResolution";

const isReadonlyPublicRecordKey = (dbKey: string): boolean =>
  dbKey.startsWith("agent-pub-") || dbKey.startsWith("cybot-pub-");

const normalizeCurrentUserId = (state: any): string | null => {
  const userId = state?.auth?.currentUser?.userId;
  return typeof userId === "string" && userId.trim().length > 0 ? userId.trim() : null;
};

export const resolveReplicationServers = (
  currentServer: string | undefined,
  syncServers: string[] | undefined,
  preferredServerOrigin?: string | null
): string[] => getAllServers(currentServer, syncServers, preferredServerOrigin);

export const resolveAuthorityReplicationServers = ({
  currentServer,
  syncServers,
  preferredServerOrigin,
  dbKey,
  record,
  state,
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  preferredServerOrigin?: string | null;
  dbKey: string;
  record?: any;
  state: any;
}): string[] => {
  const allServers = resolveReplicationServers(
    currentServer,
    syncServers,
    preferredServerOrigin
  );
  const authority = resolveRecordAuthority({
    dbKey,
    record,
    currentUserId: state?.auth?.currentUser?.userId,
    currentServer,
    userAuthorityRegistry:
      state?.settings?.userAuthorityRegistry ??
      state?.auth?.currentUser?.authorityRegistry,
  });

  // Device-local records must never leave the device.
  // Even when remote sync servers are configured and a real account is
  // logged in, we plan an empty replication list here so write/patch/remove
  // and read-backfill calls skip the network round-trip entirely.
  // Covers: owner from key (`agent-local-*` / `dialog-local-*`),
  // authoritative `record.userId === "local"` (e.g. dialog message keys
  // where dialogId is not the owner), and device-local dbKey prefixes.
  if (
    isDeviceLocalOwnerId(authority.ownerUserId) ||
    isDeviceLocalOwnerId(record?.userId) ||
    isDeviceLocalDbKey(dbKey)
  ) {
    return [];
  }

  return planAuthorityReadServers({
    allServers,
    authorityServer: preferredServerOrigin ?? authority.authorityServer,
    serverOrigin: authority.serverOrigin,
  });
};

export const scheduleWriteReplication = (
  servers: string[],
  request: { data: any; customKey: string; userId?: string },
  state: any
) => {
  if (servers.length === 0) return;
  Promise.resolve().then(async () => {
    const [primaryServer, ...backupServers] = servers;
    const primarySucceeded = await noloWriteRequest(primaryServer, request, state);

    if (!primarySucceeded) {
      console.warn(`Primary write sync failed for ${request.customKey} on ${primaryServer}`);
    }

    if (backupServers.length === 0) {
      return;
    }

    syncWithServers(
      backupServers,
      (server, requestConfig, requestState, signal) =>
        noloWriteRequest(server, requestConfig, requestState, signal, {
          failureLogLevel: "info",
        }),
      `Backup write sync failed for ${request.customKey} on`,
      request,
      state
    );
  });
};

export const resolveTenantReplicationServers = ({
  currentServer,
  syncServers,
  tenantId,
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  tenantId: string | null | undefined;
}): string[] => {
  const allServers = resolveReplicationServers(currentServer, syncServers);
  if (allServers.length === 0) {
    return [];
  }

  return planServersForTenant(allServers, currentServer, tenantId);
};

export const resolveUploadReplicationServers = ({
  currentServer,
  syncServers,
  tenantId,
  uploadConfig,
  state,
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  tenantId: string | null | undefined;
  uploadConfig: {
    metadata: any;
    customKey: string;
    userId?: string;
  };
  state: any;
}): string[] => {
  const allServers = resolveReplicationServers(currentServer, syncServers);
  const authority = resolveRecordAuthority({
    dbKey: uploadConfig.customKey,
    record: uploadConfig.metadata,
    currentUserId: state?.auth?.currentUser?.userId,
    currentServer,
    userAuthorityRegistry:
      state?.settings?.userAuthorityRegistry ??
      state?.auth?.currentUser?.authorityRegistry,
  });

  if (authority.ownerUserId || authority.authorityServer) {
    return planAuthorityReadServers({
      allServers,
      authorityServer: authority.authorityServer,
      serverOrigin: authority.serverOrigin,
    });
  }

  return resolveTenantReplicationServers({
    currentServer,
    syncServers,
    tenantId,
  });
};

export const scheduleExistingRecordReplication = ({
  currentServer,
  syncServers,
  preferredServerOrigin,
  dbKey,
  localData,
  state,
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  preferredServerOrigin?: string | null;
  dbKey: string;
  localData: any;
  state: any;
}): string[] => {
  if (isReadonlyPublicRecordKey(dbKey)) {
    return [];
  }

  const currentUserId = normalizeCurrentUserId(state);
  const authority = resolveRecordAuthority({
    dbKey,
    record: localData,
    currentUserId,
    currentServer,
    userAuthorityRegistry:
      state?.settings?.userAuthorityRegistry ??
      state?.auth?.currentUser?.authorityRegistry,
  });
  if (authority.ownerUserId && currentUserId && authority.ownerUserId !== currentUserId) {
    return [];
  }

  const servers = resolveAuthorityReplicationServers({
    currentServer,
    syncServers,
    preferredServerOrigin,
    dbKey,
    record: localData,
    state,
  });
  if (servers.length === 0) {
    return [];
  }

  scheduleWriteReplication(
    servers,
    {
      data: localData,
      customKey: dbKey,
      userId:
        typeof localData?.userId === "string"
          ? localData.userId
          : state?.auth?.currentUser?.userId,
    },
    state
  );

  return servers;
};

export const schedulePatchReplication = ({
  servers,
  dbKey,
  changes,
  state,
  preferredServerOrigin,
}: {
  servers: string[];
  dbKey: string;
  changes: any;
  state: any;
  preferredServerOrigin?: string | null;
}) => {
  if (servers.length === 0) return;

  Promise.resolve().then(async () => {
    const primaryServer =
      typeof preferredServerOrigin === "string" && preferredServerOrigin.trim().length > 0
        ? preferredServerOrigin.trim().replace(/\/+$/, "")
        : servers[0];
    const backupServers = servers.filter(
      (server) => server.replace(/\/+$/, "") !== primaryServer
    );

    const primarySucceeded = await noloPatchRequest(primaryServer, dbKey, changes, state, undefined, {
      failureLogLevel: "warn",
    });
    if (!primarySucceeded) {
      console.warn(`Primary patch sync failed for ${dbKey} on ${primaryServer}`);
    }

    if (backupServers.length > 0) {
      syncWithServers(
        backupServers,
        (server, targetDbKey, nextChanges, requestState, signal) =>
          noloPatchRequest(server, targetDbKey, nextChanges, requestState, signal, {
            failureLogLevel: "info",
          }),
        `Backup patch sync failed for ${dbKey} on`,
        dbKey,
        changes,
        state
      );
    }
  });
};

export const scheduleConfiguredPatchReplication = ({
  currentServer,
  syncServers,
  preferredServerOrigin,
  dbKey,
  changes,
  state,
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  preferredServerOrigin?: string | null;
  dbKey: string;
  changes: any;
  state: any;
}): string[] => {
  const servers = resolveAuthorityReplicationServers({
    currentServer,
    syncServers,
    preferredServerOrigin,
    dbKey,
    record: changes,
    state,
  });

  if (servers.length === 0) {
    return [];
  }

  schedulePatchReplication({
    servers,
    dbKey,
    changes,
    state,
    preferredServerOrigin,
  });

  return servers;
};

export const scheduleUploadReplication = ({
  currentServer,
  syncServers,
  tenantId,
  uploadConfig,
  state,
  excludeServers = [],
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  tenantId: string | null | undefined;
  uploadConfig: {
    file: File;
    metadata: any;
    customKey: string;
    userId?: string;
  };
  state: any;
  excludeServers?: string[];
}): string[] => {
  const servers = resolveUploadReplicationServers({
    currentServer,
    syncServers,
    tenantId,
    uploadConfig,
    state,
  });
  const excluded = new Set(
    excludeServers
      .filter((server): server is string => typeof server === "string")
      .map((server) => server.trim().replace(/\/+$/, ""))
  );
  const remainingServers = servers.filter(
    (server) => !excluded.has(server.trim().replace(/\/+$/, ""))
  );

  if (remainingServers.length === 0) {
    return [];
  }

  Promise.resolve().then(() => {
    syncWithServers(
      remainingServers,
      noloUploadRequest,
      `Upload sync failed for ${uploadConfig.customKey} on`,
      uploadConfig,
      state
    );
  });

  return remainingServers;
};

export const uploadToCurrentServer = async ({
  currentServer,
  uploadConfig,
  state,
}: {
  currentServer: string | undefined;
  uploadConfig: {
    file: File;
    metadata: any;
    customKey: string;
    userId?: string;
  };
  state: any;
}): Promise<boolean> => {
  if (!currentServer) {
    return false;
  }

  return noloUploadRequest(currentServer, uploadConfig, state);
};

export const deleteFromReplicationServers = async ({
  servers,
  dbKey,
  deleteOptions = { type: "single" as const },
  state,
  preferredServerOrigin,
}: {
  servers: string[];
  dbKey: string;
  deleteOptions?: { type: "single" | "table" | "messages" };
  state: any;
  preferredServerOrigin?: string | null;
}): Promise<{ succeeded: string[]; failed: string[] }> => {
  if (!servers.length) {
    return { succeeded: [], failed: [] };
  }

  const preferredServer =
    typeof preferredServerOrigin === "string" && preferredServerOrigin.trim().length > 0
      ? preferredServerOrigin.trim().replace(/\/+$/, "")
      : null;
  const remainingServers = preferredServer
    ? servers.filter((server) => server.replace(/\/+$/, "") !== preferredServer)
    : servers;
  const succeeded: string[] = [];
  const failed: string[] = [];

  if (preferredServer) {
    const ok = await noloDeleteRequest(preferredServer, dbKey, deleteOptions, state);
    if (ok) {
      succeeded.push(preferredServer);
    } else {
      failed.push(preferredServer);
    }
  }

  if (remainingServers.length > 0) {
    const results = await Promise.all(
      remainingServers.map(async (server) => ({
        server,
        ok: await noloDeleteRequest(server, dbKey, deleteOptions, state),
      }))
    );
    results.forEach(({ server, ok }) => {
      if (ok) succeeded.push(server);
      else failed.push(server);
    });
  }

  return { succeeded, failed };
};

export const scheduleDeleteReplication = ({
  currentServer,
  syncServers,
  preferredServerOrigin,
  dbKey,
  deleteOptions,
  state,
  onResult,
  onError,
}: {
  currentServer: string | undefined;
  syncServers: string[] | undefined;
  preferredServerOrigin?: string | null;
  dbKey: string;
  deleteOptions?: { type: "single" | "table" | "messages" };
  state: any;
  onResult?: (result: { succeeded: string[]; failed: string[] }) => void;
  onError?: (error: unknown) => void;
}): string[] => {
  const servers = resolveAuthorityReplicationServers({
    currentServer,
    syncServers,
    preferredServerOrigin,
    dbKey,
    state,
  });

  if (servers.length === 0) {
    return [];
  }

  void Promise.resolve()
    .then(() =>
      deleteFromReplicationServers({
        servers,
        dbKey,
        deleteOptions,
        state,
        preferredServerOrigin,
      })
    )
    .then((result) => {
      onResult?.(result);
    })
    .catch((error) => {
      onError?.(error);
    });

  return servers;
};
