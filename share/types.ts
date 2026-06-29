import { DataType } from "../create/types";

export type ShareType =
  | DataType.DOC
  | DataType.DIALOG
  | DataType.CYBOT
  | DataType.IMAGE
  | DataType.APP
  | DataType.TABLE;

export interface ShareMeta {
  authorId: string;
  authorName?: string;
  authorAvatar?: string;
  createdAt: number;
  updatedAt?: number | string;
  visibility: "private" | "community";
  title: string;
  description?: string;
  originalId?: string;
  mode?: "live";
  coverImage?: string;
  sourceAgentKey?: string;
  sourceAgentName?: string;
  /** Product entitlement source of truth for paid access */
  productId?: string;
  /** 被导入次数 */
  importCount?: number;
  /** 当前返回为锁定预览，未包含原始正文 */
  previewLocked?: boolean;
  /** 当前用户需要购买后才能获取原始内容 */
  requiresPurchase?: boolean;
  originServer?: string;
  tableDbKey?: string;
  tableOwnerId?: string;
  replicaServers?: string[];
  lastReplicationAt?: number;
  replicationDirtyAt?: number;
  lastReplicationError?: string;
}

export interface SharedObject {
  type: ShareType;
  version: number;
  data: Record<string, unknown>;
  meta: ShareMeta;
  createdAt?: number | string;
  updatedAt?: number | string;
}

export interface ShareSummary {
  token: string;
  type: ShareType;
  title: string;
  description?: string;
  createdAt: number;
  authorId: string;
  authorName?: string;
  authorAvatar?: string;
  coverImage?: string;
  coverImageUrl?: string;
  agentKey?: string;
  agentName?: string;
  visibility?: "private" | "community";
  originalId?: string;
  mode?: "live";
  originServer?: string;
  tableDbKey?: string;
  tableOwnerId?: string;
  replicaServers?: string[];
  lastReplicationAt?: number;
  replicationDirtyAt?: number;
  lastReplicationError?: string;
  /** App URL — populated only for DataType.APP shares */
  url?: string;
  /** 被导入次数 */
  importCount?: number;
  /** 更新时间（毫秒时间戳） */
  updatedAt?: number;
}

export const isShareType = (type: unknown): type is ShareType =>
  type === DataType.DOC ||
  type === DataType.DIALOG ||
  type === DataType.CYBOT ||
  type === DataType.IMAGE ||
  type === DataType.APP ||
  type === DataType.TABLE;

export const SHARE_TYPE_LABELS: Record<ShareType, string> = {
  [DataType.DOC]: "文章",
  [DataType.DIALOG]: "对话",
  [DataType.IMAGE]: "图片",
  [DataType.CYBOT]: "AI",
  [DataType.APP]: "应用",
  [DataType.TABLE]: "表格",
};

export const getShareTypeLabel = (type: ShareType): string =>
  SHARE_TYPE_LABELS[type] ?? "未知";
