import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Level } from "level";

/**
 * 扫描本地 LevelDB 副本，删除指定 agent key。
 * 单实例架构下只需清理 CLI 缓存和 server DB。
 */
export async function clearAgentKeysFromLocalLevelDbs(args: {
  keys: string[];
}): Promise<string[]> {
  const home = os.homedir();
  const noloHome = process.env.NOLO_HOME?.trim() || path.join(home, ".nolo");
  const dbPaths: string[] = [];

  // CLI 用户级缓存
  const cliDb = path.join(noloHome, "data", "leveldb");
  if (fs.existsSync(cliDb)) dbPaths.push(cliDb);

  // Server DB（如果显式配置）
  const serverDbPath = process.env.NOLO_SERVER_DB_PATH?.trim();
  if (serverDbPath && fs.existsSync(serverDbPath) && !dbPaths.includes(serverDbPath)) {
    dbPaths.push(serverDbPath);
  }

  const cleaned: string[] = [];
  for (const dbPath of dbPaths) {
    try {
      const db = new Level(dbPath, { valueEncoding: "json" });
      await db.open();
      try {
        for (const key of args.keys) {
          try {
            await db.del(key);
          } catch {
            // key not found is fine
          }
        }
        cleaned.push(dbPath);
      } finally {
        await db.close();
      }
    } catch {
      // DB 被锁定或无法打开，跳过
    }
  }
  return cleaned;
}
