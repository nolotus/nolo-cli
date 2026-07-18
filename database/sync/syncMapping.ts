/**
 * Explicit local↔account content mappings for local-first sync.
 *
 * Production authority is durable device-local rows under `syncmap-local-*`
 * (see syncMappingDurable / syncMappingKeys). An in-memory index stays the
 * sync read path for React (useMyContentItems) after hydrate.
 *
 * Space-as-unit sync is deferred; this store tracks selectable standalone keys.
 */

import { asOptionalPositiveFiniteNumber } from "../../core/optionalPositiveNumber";
import { asTrimmedString } from "../../core/trimmedString";
import {
  loadSyncMappingsFromDb,
  persistSyncMappingToDb,
  removeSyncMappingFromDb,
  type SyncMappingClientDb,
} from "./syncMappingDurable";

export type SyncMappingContentType =
  | "agent"
  | "dialog"
  | "page"
  | "doc"
  | "app"
  | "table"
  | "file"
  | "image"
  | "space"
  | (string & {});

export type SyncMapping = {
  localDbKey: string;
  remoteDbKey: string;
  accountUserId: string;
  contentType: SyncMappingContentType;
  updatedAt: number;
};

export type SyncMappingListFilter = {
  accountUserId?: string;
  contentType?: SyncMappingContentType;
};

export type SyncMappingStore = {
  put(mapping: SyncMappingInput): SyncMapping;
  /**
   * Look up by local key. When `accountUserId` is set, returns the
   * account-scoped mapping only. Without account, returns the newest mapping
   * for that local key (test helper / single-account callers).
   */
  get(localDbKey: string, accountUserId?: string): SyncMapping | null;
  getByRemoteDbKey(
    remoteDbKey: string,
    accountUserId?: string
  ): SyncMapping | null;
  list(filter?: SyncMappingListFilter): SyncMapping[];
  remove(localDbKey: string, accountUserId?: string): boolean;
  clear(): void;
  size(): number;
};

export type SyncMappingInput = {
  localDbKey: string;
  remoteDbKey: string;
  accountUserId: string;
  contentType: SyncMappingContentType;
  updatedAt?: number;
};

const normalizeKey = (value: unknown): string => asTrimmedString(value);

const normalizeContentType = (value: unknown): SyncMappingContentType => {
  const trimmed = normalizeKey(value);
  return trimmed.length > 0 ? trimmed : "unknown";
};

const toUpdatedAt = (value: unknown, fallback: number): number => {
  const asNumber = asOptionalPositiveFiniteNumber(value);
  if (asNumber !== undefined) return asNumber;
  if (typeof value === "string" && value.trim()) {
    return asOptionalPositiveFiniteNumber(Date.parse(value)) ?? fallback;
  }
  return fallback;
};

const pairKey = (accountUserId: string, localDbKey: string): string =>
  `${accountUserId}\0${localDbKey}`;

export function normalizeSyncMapping(
  input: SyncMappingInput,
  now = Date.now()
): SyncMapping {
  const localDbKey = normalizeKey(input.localDbKey);
  const remoteDbKey = normalizeKey(input.remoteDbKey);
  const accountUserId = normalizeKey(input.accountUserId);
  const contentType = normalizeContentType(input.contentType);

  if (!localDbKey) {
    throw new Error("syncMapping.localDbKey is required");
  }
  if (!remoteDbKey) {
    throw new Error("syncMapping.remoteDbKey is required");
  }
  if (!accountUserId) {
    throw new Error("syncMapping.accountUserId is required");
  }
  if (localDbKey === remoteDbKey) {
    throw new Error("syncMapping.localDbKey and remoteDbKey must differ");
  }
  if (accountUserId === "local") {
    throw new Error(
      "syncMapping.accountUserId must be a non-local account user id"
    );
  }

  return {
    localDbKey,
    remoteDbKey,
    accountUserId,
    contentType,
    updatedAt: toUpdatedAt(input.updatedAt, now),
  };
}

export function createSyncMappingStore(options?: {
  now?: () => number;
}): SyncMappingStore {
  const now = options?.now ?? Date.now;
  /** Indexed by accountUserId\0localDbKey — account-scoped pairs. */
  const byPair = new Map<string, SyncMapping>();
  /** Secondary: remoteDbKey → pair key (unique remote identity). */
  const remoteToPair = new Map<string, string>();

  const forgetRemoteIndex = (mapping: SyncMapping | null | undefined) => {
    if (!mapping) return;
    const current = remoteToPair.get(mapping.remoteDbKey);
    if (current === pairKey(mapping.accountUserId, mapping.localDbKey)) {
      remoteToPair.delete(mapping.remoteDbKey);
    }
  };

  return {
    put(input) {
      const mapping = normalizeSyncMapping(input, now());
      const key = pairKey(mapping.accountUserId, mapping.localDbKey);
      const previousLocal = byPair.get(key);
      if (previousLocal) {
        forgetRemoteIndex(previousLocal);
      }

      // Remote key can only point at one mapping; replace prior link if needed.
      const previousPairForRemote = remoteToPair.get(mapping.remoteDbKey);
      if (previousPairForRemote && previousPairForRemote !== key) {
        const displaced = byPair.get(previousPairForRemote);
        if (displaced) {
          byPair.delete(previousPairForRemote);
        }
      }

      byPair.set(key, mapping);
      remoteToPair.set(mapping.remoteDbKey, key);
      return { ...mapping };
    },

    get(localDbKey, accountUserId) {
      const local = normalizeKey(localDbKey);
      if (!local) return null;
      const account = normalizeKey(accountUserId);
      if (account) {
        const mapping = byPair.get(pairKey(account, local));
        return mapping ? { ...mapping } : null;
      }
      // Newest mapping for this local key across accounts (test helper).
      let best: SyncMapping | null = null;
      for (const mapping of byPair.values()) {
        if (mapping.localDbKey !== local) continue;
        if (!best || mapping.updatedAt > best.updatedAt) {
          best = mapping;
        }
      }
      return best ? { ...best } : null;
    },

    getByRemoteDbKey(remoteDbKey, accountUserId) {
      const key = normalizeKey(remoteDbKey);
      if (!key) return null;
      const pair = remoteToPair.get(key);
      if (!pair) return null;
      const mapping = byPair.get(pair);
      if (!mapping) return null;
      const account = normalizeKey(accountUserId);
      if (account && mapping.accountUserId !== account) return null;
      return { ...mapping };
    },

    list(filter) {
      const accountUserId = normalizeKey(filter?.accountUserId);
      const contentType = normalizeKey(filter?.contentType);
      const rows = Array.from(byPair.values()).filter((mapping) => {
        if (accountUserId && mapping.accountUserId !== accountUserId) {
          return false;
        }
        if (contentType && mapping.contentType !== contentType) return false;
        return true;
      });
      return rows
        .map((mapping) => ({ ...mapping }))
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            left.localDbKey.localeCompare(right.localDbKey) ||
            left.accountUserId.localeCompare(right.accountUserId)
        );
    },

    remove(localDbKey, accountUserId) {
      const local = normalizeKey(localDbKey);
      if (!local) return false;
      const account = normalizeKey(accountUserId);
      if (account) {
        const key = pairKey(account, local);
        const existing = byPair.get(key);
        if (!existing) return false;
        byPair.delete(key);
        forgetRemoteIndex(existing);
        return true;
      }
      let removed = false;
      for (const [key, mapping] of Array.from(byPair.entries())) {
        if (mapping.localDbKey !== local) continue;
        byPair.delete(key);
        forgetRemoteIndex(mapping);
        removed = true;
      }
      return removed;
    },

    clear() {
      byPair.clear();
      remoteToPair.clear();
    },

    size() {
      return byPair.size;
    },
  };
}

/** Process-local default store. Tests should prefer createSyncMappingStore(). */
const defaultSyncMappingStore = createSyncMappingStore();

/**
 * Version + subscribe for React consumers (useMyContentItems etc.).
 * Bumps only when consumer-visible mapping identity changes enough to
 * re-run dedupe (not on identical put of the same pair/remote/type).
 */
let mappingVersion = 0;
const mappingListeners = new Set<() => void>();

/** Snapshot equality for list/dedupe consumers (updatedAt alone is ignored). */
const sameConsumerMapping = (
  a: SyncMapping | null | undefined,
  b: SyncMapping | null | undefined
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.localDbKey === b.localDbKey &&
    a.remoteDbKey === b.remoteDbKey &&
    a.accountUserId === b.accountUserId &&
    a.contentType === b.contentType
  );
};

const notifySyncMappingListeners = (): void => {
  mappingVersion += 1;
  for (const listener of mappingListeners) {
    try {
      listener();
    } catch {
      /* subscriber errors must not break mutators */
    }
  }
};

/** Subscribe to default-store mapping version changes (useSyncExternalStore). */
export function subscribeSyncMappingVersion(
  listener: () => void
): () => void {
  mappingListeners.add(listener);
  return () => {
    mappingListeners.delete(listener);
  };
}

/** Monotonic version for useSyncExternalStore getSnapshot. */
export function getSyncMappingVersion(): number {
  return mappingVersion;
}

/** Optional durable backend for production write-through / hydrate. */
let boundClientDb: SyncMappingClientDb | null = null;
let mappingsHydrated = false;
/**
 * Epoch bumped by clear/bind so in-flight hydrates cannot commit into a
 * newer memory/DB binding. We do not abort Level iterators; we ignore stale
 * results at commit time (generation guard).
 */
let hydrateEpoch = 0;
let hydrateInFlight: { epoch: number; promise: Promise<boolean> } | null =
  null;

/**
 * Bind the device client DB used for durable mapping persistence.
 * Bumps hydrate epoch so any older in-flight hydrate is ignored on commit.
 */
export function bindSyncMappingClientDb(db: SyncMappingClientDb | null): void {
  boundClientDb = db;
  mappingsHydrated = false;
  hydrateEpoch += 1;
}

export function getBoundSyncMappingClientDb(): SyncMappingClientDb | null {
  return boundClientDb;
}

/**
 * Load durable mappings into the process default store.
 * Safe to call multiple times; returns true when this call performed a load.
 * Does not write. Auth reset clears memory and marks unhydrated so this reloads.
 * Stale in-flight loads (after clear/bind) never repopulate memory or mark hydrated.
 */
export async function ensureSyncMappingsHydrated(
  db?: SyncMappingClientDb | null
): Promise<boolean> {
  const client = db ?? boundClientDb;
  if (!client) return false;
  if (mappingsHydrated) return false;

  // Coalesce concurrent hydrates for the current epoch only.
  if (hydrateInFlight && hydrateInFlight.epoch === hydrateEpoch) {
    await hydrateInFlight.promise;
    return false;
  }

  const epoch = hydrateEpoch;
  const clientAtStart = client;

  const promise = (async (): Promise<boolean> => {
    const rows = await loadSyncMappingsFromDb(clientAtStart);
    // Commit guard: clear/bind during await invalidates this load.
    if (epoch !== hydrateEpoch) {
      return false;
    }
    // Replace memory with durable truth for this device (keeps multi-account rows).
    // Sync section is atomic w.r.t. other JS (no await) so epoch cannot flip mid-commit.
    const beforeSize = defaultSyncMappingStore.size();
    defaultSyncMappingStore.clear();
    for (const row of rows) {
      try {
        defaultSyncMappingStore.put(row);
      } catch {
        // Skip corrupt rows rather than failing the whole hydrate.
      }
    }
    mappingsHydrated = true;
    // Notify when cold hydrate can change what listSyncMappings returns
    // (empty→rows, rows→empty, or any replace after clear).
    if (beforeSize > 0 || rows.length > 0 || defaultSyncMappingStore.size() > 0) {
      notifySyncMappingListeners();
    }
    return true;
  })();

  hydrateInFlight = { epoch, promise };

  try {
    return await promise;
  } finally {
    if (hydrateInFlight?.promise === promise) {
      hydrateInFlight = null;
    }
  }
}

export function putSyncMapping(mapping: SyncMappingInput): SyncMapping {
  const account = normalizeKey(mapping.accountUserId);
  const local = normalizeKey(mapping.localDbKey);
  const previous =
    account && local ? defaultSyncMappingStore.get(local, account) : null;
  const next = defaultSyncMappingStore.put(mapping);
  if (!sameConsumerMapping(previous, next)) {
    notifySyncMappingListeners();
  }
  return next;
}

/**
 * Memory put + durable write-through. Requires a bound client DB.
 * Refuses silent memory-only "durability" when no DB is bound.
 */
export async function putSyncMappingDurable(
  mapping: SyncMappingInput
): Promise<SyncMapping> {
  const normalized = normalizeSyncMapping(mapping);
  if (!boundClientDb) {
    throw new Error(
      "putSyncMappingDurable requires a bound client DB; refuse silent memory-only durability"
    );
  }
  await persistSyncMappingToDb(boundClientDb, normalized);
  // Route through putSyncMapping so consumers get a single notify path.
  return putSyncMapping(normalized);
}

export function getSyncMapping(
  localDbKey: string,
  accountUserId?: string
): SyncMapping | null {
  return defaultSyncMappingStore.get(localDbKey, accountUserId);
}

export function getSyncMappingByRemoteDbKey(
  remoteDbKey: string,
  accountUserId?: string
): SyncMapping | null {
  return defaultSyncMappingStore.getByRemoteDbKey(remoteDbKey, accountUserId);
}

export function listSyncMappings(filter?: SyncMappingListFilter): SyncMapping[] {
  return defaultSyncMappingStore.list(filter);
}

export function removeSyncMapping(
  localDbKey: string,
  accountUserId?: string
): boolean {
  const removed = defaultSyncMappingStore.remove(localDbKey, accountUserId);
  if (removed) {
    notifySyncMappingListeners();
  }
  return removed;
}

export async function removeSyncMappingDurable(
  localDbKey: string,
  accountUserId: string
): Promise<boolean> {
  const account = normalizeKey(accountUserId);
  const local = normalizeKey(localDbKey);
  if (!account || !local) return false;
  if (boundClientDb) {
    await removeSyncMappingFromDb(boundClientDb, account, local);
  }
  return removeSyncMapping(local, account);
}

/**
 * Wipe the process default mapping store (auth reset / tests).
 * Does NOT delete durable on-device rows — they rehydrate when the account
 * becomes active again via ensureSyncMappingsHydrated.
 * Bumps hydrate epoch so any older in-flight hydrate cannot repopulate memory.
 */
export function clearSyncMappings(): void {
  const hadRows = defaultSyncMappingStore.size() > 0;
  defaultSyncMappingStore.clear();
  mappingsHydrated = false;
  hydrateEpoch += 1;
  if (hadRows) {
    notifySyncMappingListeners();
  }
}

export function getDefaultSyncMappingStore(): SyncMappingStore {
  return defaultSyncMappingStore;
}

export function areSyncMappingsHydrated(): boolean {
  return mappingsHydrated;
}
