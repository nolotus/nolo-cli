import fs from "fs";
import path from "path";
import { Level } from "level";

import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import type { AuthorityStore } from "./authorityStoreTypes";
import { createLegacyServerDb, type LegacyServerDb } from "./legacyServerDb";
import { createLevelAuthorityStore } from "./levelAuthorityStore";
import { createMemoryAuthorityStore } from "./memoryAuthorityStore";

export type ServerStoreDriver = "level" | "memory";

export type ServerStoreFactoryEnv = {
  NOLO_SERVER_AUTHORITY_DRIVER?: string | undefined;
};

export const safeJsonEncoding = {
  name: "safe-json",
  format: "utf8" as const,
  encode: (data: any) => JSON.stringify(data),
  decode: (data: string) => {
    try {
      return JSON.parse(data);
    } catch {
      console.warn("[LevelDB] Corrupted value:", data?.substring?.(0, 60));
      return null;
    }
  },
};

export type ServerStoreRuntime = {
  authorityStore: AuthorityStore;
  serverDb: LegacyServerDb;
};

export type ServerStoreFactoryOptions = {
  driver?: ServerStoreDriver;
  env?: ServerStoreFactoryEnv;
  globalScope?: Record<string, unknown>;
};

export function ensureServerDbDirectory(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createLevelBackedAuthorityStore(dbPath: string): AuthorityStore {
  const levelDb = new Level<string, any>(dbPath, {
    valueEncoding: safeJsonEncoding,
  });
  // Level package typings are stricter than the store's LevelLike surface.
  return createLevelAuthorityStore(levelDb as any);
}

export function resolveServerStoreDriver(
  env: ServerStoreFactoryEnv | NodeJS.ProcessEnv = process.env
): ServerStoreDriver {
  const rawDriver = asTrimmedLowercaseString(env.NOLO_SERVER_AUTHORITY_DRIVER);
  if (!rawDriver) return "level";
  if (rawDriver === "level") return "level";
  if (rawDriver === "memory") return "memory";
  throw new Error(`Unsupported server authority store driver: ${rawDriver}`);
}

export function createAuthorityStoreForDriver(
  driver: ServerStoreDriver,
  dbPath: string
): AuthorityStore {
  switch (driver) {
    case "level":
      return createLevelBackedAuthorityStore(dbPath);
    case "memory":
      return createMemoryAuthorityStore(dbPath);
  }
}

export function getOrCreateServerStoreRuntime(
  dbPath: string,
  options: ServerStoreFactoryOptions = {}
): ServerStoreRuntime {
  const globalScope =
    options.globalScope ?? (globalThis as Record<string, unknown>);
  const driver = options.driver ?? resolveServerStoreDriver(options.env);
  const cachedDriver = globalScope.__serverAuthorityStoreDriver;

  ensureServerDbDirectory(dbPath);

  if (
    globalScope.__serverAuthorityStore &&
    typeof cachedDriver === "string" &&
    cachedDriver !== driver
  ) {
    throw new Error(
      `Server authority store already initialized with driver ${cachedDriver}, cannot reuse it for ${driver}`
    );
  }

  if (!globalScope.__serverAuthorityStore) {
    globalScope.__serverAuthorityStore = createAuthorityStoreForDriver(
      driver,
      dbPath
    );
    globalScope.__serverAuthorityStoreDriver = driver;
  } else if (!cachedDriver) {
    globalScope.__serverAuthorityStoreDriver = driver;
  }

  const authorityStore = globalScope.__serverAuthorityStore as AuthorityStore;

  if (!globalScope.__serverDb) {
    globalScope.__serverDb = createLegacyServerDb(authorityStore);
  }

  return {
    authorityStore,
    serverDb: globalScope.__serverDb as LegacyServerDb,
  };
}
