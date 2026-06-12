import { homedir } from "node:os";
import path from "node:path";

type EnvLike = Record<string, string | undefined>;

export type ResolveServerDbPathOptions = {
  env?: EnvLike;
  homeDir?: string;
  cwd?: string;
};

export function resolveServerDbPath(options: ResolveServerDbPathOptions = {}) {
  const env = options.env ?? process.env;
  return env.NOLO_SERVER_DB_PATH?.trim() || path.join(options.cwd ?? process.cwd(), "data", "leveldb");
}

export function resolveNoloHome(options: ResolveServerDbPathOptions = {}) {
  const env = options.env ?? process.env;
  return env.NOLO_HOME?.trim() || path.join(options.homeDir ?? homedir(), ".nolo");
}
