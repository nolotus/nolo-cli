// 会话快照桥：把 redux 里的身份/服务器状态镜像为模块级快照，
// 让 usage 域（useUsageApiDeps / 余额卡片）读端脱离 redux API。
//
// 设计：
// - 本文件**零依赖**（不 import 任何 slice/selector）——快照的读取函数
//   （SnapshotReader）由 createAppStore 用闭包注入（见 app/store.ts），
//   避免把 reducer 树静态拉进用法域 import 图（曾因循环 import 炸测试）。
// - 写端仍是 redux reducer；本模块仅订阅镜像。
// - 读端一律 useSyncExternalStore(get/set)；测试 mock.module 本文件即可，
//   无需 redux Provider。
// - 未来全量剥离 redux 时，把 configureSessionSnapshot 换成模块 setter，
//   读端零改动。
import { useSyncExternalStore } from "react";

export interface SessionSnapshot {
  token: string | null;
  server: string;
  balance: number | undefined;
  userId: string | null;
  /** 远程服务器列表（currentServer + syncServers），供账号删除等多服务器写操作读端使用 */
  servers: string[];
}

export type SnapshotReader = (state: any) => SessionSnapshot;

const EMPTY: SessionSnapshot = {
  token: null,
  server: "",
  balance: undefined,
  userId: null,
  servers: [],
};

interface SessionStoreLike {
  getState(): any;
  subscribe(fn: () => void): () => void;
}

let reader: SnapshotReader | null = null;
let attached: SessionStoreLike | null = null;
let snapshot: SessionSnapshot = EMPTY;
let unsub: (() => void) | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((fn) => fn());
};

const readSnapshot = (store: SessionStoreLike): SessionSnapshot =>
  reader ? reader(store.getState()) : EMPTY;

/**
 * 由 createAppStore 传入快照读取函数（store.ts 用现有 selectors 组装）。
 */
export function configureSessionSnapshot(fn: SnapshotReader): void {
  reader = fn;
  if (attached) {
    snapshot = readSnapshot(attached);
    emit();
  }
}

/** 由 createAppStore 在实例创建后调用。返回解绑函数。 */
export function attachSessionSnapshot(store: SessionStoreLike): () => void {
  unsub?.();
  attached = store;
  snapshot = readSnapshot(store);
  unsub = store.subscribe(() => {
    snapshot = readSnapshot(store);
    emit();
  });
  emit();
  return () => {
    unsub?.();
    unsub = null;
    attached = null;
  };
}

/** 快照桥是否已挂载（web 客户端 createAppStore 挂载；RN 等未挂桥环境为 false，调用方需兜底）。 */
export const isSessionSnapshotAttached = (): boolean => attached !== null;

export const getSessionSnapshot = (): SessionSnapshot => snapshot;

export const subscribeSessionSnapshot = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const useSessionSnapshot = (): SessionSnapshot =>
  // 第三参 getServerSnapshot 必填：/life,/life/usage 为 lazy 路由且无登录门，
  // hydrate 恢复 mount 时若缺它会 throw（W1，2026-08-21 review）。
  useSyncExternalStore(
    subscribeSessionSnapshot,
    getSessionSnapshot,
    getSessionSnapshot
  );
