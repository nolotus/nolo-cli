import type { CliLocalRuntimeDb } from "./client/localRuntimeAdapter";
import path from "node:path";
import { resolveNoloHome } from "../database-engine/dbPath";

type EnvLike = Record<string, string | undefined>;

type CliLocalRuntimeDbPathOptions = {
  env?: EnvLike;
  homeDir?: string;
};

export function resolveCliLocalRuntimeDbPath(options: CliLocalRuntimeDbPathOptions = {}) {
  return path.join(resolveNoloHome(options), "data", "leveldb");
}

export function buildCliLocalRuntimeDbEnv(env: EnvLike = process.env) {
  return {
    ...env,
    NOLO_SERVER_DB_PATH: env.NOLO_SERVER_DB_PATH?.trim() || resolveCliLocalRuntimeDbPath({ env }),
  };
}

export async function getDefaultCliLocalRuntimeDb(
  options: CliLocalRuntimeDbPathOptions = {}
): Promise<CliLocalRuntimeDb> {
  const { getDefaultCliLocalRuntimeDb: getAuthorityBackedDb } = await import("./localRuntimeAuthority");
  return getAuthorityBackedDb(options);
}
