// packages/cli/client/fileSystemStores.ts
//
// CLI 层 I/O 适配：把共享层 TodoStore 契约落到本地文件。
//
// 分层边界（review 重点）：
// - 共享层 runtimeTodo.ts 不碰 node:fs，只定义契约 + 纯逻辑；本文件是 CLI
//   专属适配层，允许 import node:fs。
// - 读写只在进程内生效（CLI 短生命周期），不跨进程共享；server 端应落 DB。
// - 所有时间戳由调用方传入或用 Date.now()（存储层允许取时钟，判定层不允许）。
//
// 设计取舍：用单文件 JSON 而非每条一文件，因为条目数量小（熔断表通常 < 10，
// todo 通常 < 100），单文件原子读写更简单且避免目录扫描。非并发安全——
// CLI 单进程编排场景可接受；server 不可直接复用。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { dirname, join } from "node:path";

// node:fs 的子集（避免 import * as nodeFs 形成类型耦合）。
const nodeFs = {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} as const;
import type {
  AgentRunTodoRecord,
  AgentRunTodoStatus,
  AgentRunTodoStore,
} from "../../ai/tools/agent/agentRunTodo";

type EnvLike = Record<string, string | undefined>;
type FsLike = {
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  readFileSync: typeof readFileSync;
  existsSync: typeof existsSync;
};

/** 解析 ~/.nolo 根目录（与 agentRunControl.resolveNoloHome 同语义，但本模块
 *  独立解析避免反向 import CLI 控制面——stores 只依赖共享层契约）。 */
function resolveNoloHome(env: EnvLike, homedir: () => string): string {
  const custom = env?.NOLO_HOME;
  if (custom && custom.trim()) return custom.trim();
  return join(homedir(), ".nolo");
}

function ensureDir(dir: string, fs: FsLike): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(path: string, fs: FsLike): T | undefined {
  if (!fs.existsSync(path)) return undefined;
  try {
    const raw = fs.readFileSync(path, "utf8");
    return JSON.parse(String(raw)) as T;
  } catch {
    // 损坏文件：当作不存在，下次写入会覆盖。不抛——存储层不应让编排者崩。
    return undefined;
  }
}

function writeJson(path: string, data: unknown, fs: FsLike): void {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─────────────────────────── TodoStore ───────────────────────────

export interface FileSystemTodoStoreOptions {
  env?: EnvLike;
  homedir?: () => string;
  fs?: FsLike;
  /** 文件路径覆盖（测试用）；缺省 ~/.nolo/agent_run_todos.json。 */
  filePath?: string;
}

/**
 * CLI 本地文件 AgentRunTodo 适配。形状 `{ todos: AgentRunTodoRecord[] }`，按 id 去重更新。
 * 具备向后兼容迁移：如果 agent_run_todos.json 不存在而旧 todos.json 存在，自动自动迁移。
 */
export function createFileSystemTodoStore(
  opts: FileSystemTodoStoreOptions = {},
): AgentRunTodoStore & { putTodo: (todo: AgentRunTodoRecord) => Promise<void> } {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? nodeHomedir;
  const fs = opts.fs ?? (nodeFs as unknown as FsLike);
  const noloHome = resolveNoloHome(env, homedir);
  const filePath = opts.filePath ?? join(noloHome, "agent_run_todos.json");
  const oldFilePath = join(noloHome, "todos.json");

  const loadMap = (): Map<string, AgentRunTodoRecord> => {
    // 检查向后兼容迁移：如果新文件 (agent_run_todos.json) 不存在，且旧文件 (todos.json) 存在，
    // 自动平滑迁移。明确保留原 item 上的所有扩展属性 (...item)，显式兼容旧版历史数据而不丢失关键信息。
    if (!opts.filePath && !fs.existsSync(filePath) && fs.existsSync(oldFilePath)) {
      const oldData = readJson<{ todos?: any[] }>(oldFilePath, fs);
      const map = new Map<string, AgentRunTodoRecord>();
      if (oldData?.todos) {
        for (const item of oldData.todos) {
          if (item && typeof item.id === "string") {
            let status: AgentRunTodoStatus = "pending";
            if (item.status === "running") status = "running";
            else if (item.status === "done") status = "done";
            else if (item.status === "blocked" || item.status === "abandoned" || item.status === "failed") status = "failed";
            
            const rec: AgentRunTodoRecord = {
              ...item,
              id: item.id,
              title: item.title || "Untitled Task",
              status,
              runIds: Array.isArray(item.runIds) ? item.runIds : [],
              createdAt: item.createdAt || new Date().toISOString(),
              updatedAt: item.updatedAt || new Date().toISOString(),
            };
            map.set(rec.id, rec);
          }
        }
      }
      ensureDir(dirname(filePath), fs);
      writeJson(filePath, { todos: [...map.values()] }, fs);
      return map;
    }

    const data = readJson<{ todos?: AgentRunTodoRecord[] }>(filePath, fs);
    const map = new Map<string, AgentRunTodoRecord>();
    if (data?.todos) {
      for (const todo of data.todos) {
        if (todo && typeof todo.id === "string") map.set(todo.id, todo);
      }
    }
    return map;
  };

  const persist = (map: Map<string, AgentRunTodoRecord>): void => {
    ensureDir(dirname(filePath), fs);
    writeJson(filePath, { todos: [...map.values()] }, fs);
  };

  return {
    async getTodo(id: string): Promise<AgentRunTodoRecord | null> {
      return loadMap().get(id) ?? null;
    },
    async listTodos(): Promise<AgentRunTodoRecord[]> {
      return [...loadMap().values()];
    },
    async saveTodo(todo: AgentRunTodoRecord): Promise<void> {
      const map = loadMap();
      map.set(todo.id, todo);
      persist(map);
    },
    async putTodo(todo: AgentRunTodoRecord): Promise<void> {
      const map = loadMap();
      map.set(todo.id, todo);
      persist(map);
    },
    async deleteTodo(id: string): Promise<boolean> {
      const map = loadMap();
      const existed = map.has(id);
      map.delete(id);
      persist(map);
      return existed;
    },
  };
}

