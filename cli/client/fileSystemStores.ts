// packages/cli/client/fileSystemStores.ts
//
// CLI 层 I/O 适配：把共享层（零 I/O）的 CircuitBreakerStore / TodoStore 契约
// 落到本地文件（~/.nolo/breakers.json / ~/.nolo/todos.json）。
//
// 分层边界（review 重点）：
// - 共享层 quotaCircuitBreaker.ts / runtimeTodo.ts 不碰 node:fs，只定义契约 +
//   纯逻辑；本文件是 CLI 专属适配层，允许 import node:fs。
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
  CircuitBreakerEntry,
  CircuitBreakerStore,
} from "../../ai/tools/agent/quotaCircuitBreaker";
import type {
  TodoRecord,
  TodoStatus,
  TodoStore,
} from "../../ai/tools/agent/runtimeTodo";

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

// ─────────────────────────── CircuitBreakerStore ───────────────────────────

export interface FileSystemCircuitBreakerStoreOptions {
  env?: EnvLike;
  homedir?: () => string;
  fs?: FsLike;
  /** 文件路径覆盖（测试用）；缺省 ~/.nolo/breakers.json。 */
  filePath?: string;
}

/**
 * CLI 本地文件熔断表适配。条目按 target 为键存入一个 JSON 对象
 * `{ entries: CircuitBreakerEntry[] }`，get/set/clear/clearAll 同步落盘。
 *
 * 同步语义：与共享层 createInMemoryCircuitBreakerStore 的契约一致（同步 get/set），
 * 文件读写也是同步 API，所以无需 Promise 包装。
 */
export function createFileSystemCircuitBreakerStore(
  opts: FileSystemCircuitBreakerStoreOptions = {},
): CircuitBreakerStore {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? nodeHomedir;
  const fs = opts.fs ?? (nodeFs as unknown as FsLike);
  const filePath =
    opts.filePath ?? join(resolveNoloHome(env, homedir), "breakers.json");

  const loadMap = (): Map<string, CircuitBreakerEntry> => {
    const data = readJson<{ entries?: CircuitBreakerEntry[] }>(filePath, fs);
    const map = new Map<string, CircuitBreakerEntry>();
    if (data?.entries) {
      for (const entry of data.entries) {
        if (entry && typeof entry.target === "string") map.set(entry.target, entry);
      }
    }
    return map;
  };

  const persist = (map: Map<string, CircuitBreakerEntry>): void => {
    ensureDir(dirname(filePath), fs);
    writeJson(filePath, { entries: [...map.values()] }, fs);
  };

  return {
    get(target: string): CircuitBreakerEntry | undefined {
      return loadMap().get(target);
    },
    set(entry: CircuitBreakerEntry): void {
      const map = loadMap();
      map.set(entry.target, entry);
      persist(map);
    },
    clear(target: string): void {
      const map = loadMap();
      map.delete(target);
      persist(map);
    },
    clearAll(): void {
      persist(new Map());
    },
  };
}

// ─────────────────────────── TodoStore ───────────────────────────

export interface FileSystemTodoStoreOptions {
  env?: EnvLike;
  homedir?: () => string;
  fs?: FsLike;
  /** 文件路径覆盖（测试用）；缺省 ~/.nolo/todos.json。 */
  filePath?: string;
}

/**
 * CLI 本地文件 todo 适配。形状 `{ todos: TodoRecord[] }`，按 id 去重更新。
 *
 * TodoStore 契约是 async（server 落 DB 是 async），文件实现内部同步但保持
 * async 签名，以便上层无差别替换为 server/DB 实现。
 */
export function createFileSystemTodoStore(
  opts: FileSystemTodoStoreOptions = {},
): TodoStore {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? nodeHomedir;
  const fs = opts.fs ?? (nodeFs as unknown as FsLike);
  const filePath =
    opts.filePath ?? join(resolveNoloHome(env, homedir), "todos.json");

  const loadMap = (): Map<string, TodoRecord> => {
    const data = readJson<{ todos?: TodoRecord[] }>(filePath, fs);
    const map = new Map<string, TodoRecord>();
    if (data?.todos) {
      for (const todo of data.todos) {
        if (todo && typeof todo.id === "string") map.set(todo.id, todo);
      }
    }
    return map;
  };

  const persist = (map: Map<string, TodoRecord>): void => {
    ensureDir(dirname(filePath), fs);
    writeJson(filePath, { todos: [...map.values()] }, fs);
  };

  return {
    async getTodo(id: string): Promise<TodoRecord | undefined> {
      return loadMap().get(id);
    },
    async listTodos(filter?: { statuses?: TodoStatus[] }): Promise<TodoRecord[]> {
      const all = [...loadMap().values()];
      if (!filter?.statuses || filter.statuses.length === 0) return all;
      const wanted = new Set(filter.statuses);
      return all.filter((t) => wanted.has(t.status));
    },
    async putTodo(todo: TodoRecord): Promise<void> {
      const map = loadMap();
      map.set(todo.id, todo);
      persist(map);
    },
    async deleteTodo(id: string): Promise<void> {
      const map = loadMap();
      map.delete(id);
      persist(map);
    },
  };
}

