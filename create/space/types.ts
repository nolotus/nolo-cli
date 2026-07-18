import { SpaceData, SpaceMemberWithSpaceInfo } from "../../app/types";

export type SpaceId = string;

export type SpaceViewMode = "all" | "categories";

/**
 * Authoritative membership list freshness for UI/offline UX.
 * - idle: no refresh yet (or status cleared on account switch)
 * - loading: refresh in progress; cached memberSpaces kept
 * - fresh: last refresh completed with remote/local authority
 * - offline: remote membership unavailable; memberSpaces may be stale cache
 */
export type MembershipStatus = "idle" | "loading" | "fresh" | "offline";

export interface CreateSpaceRequest {
  name: string;
  description?: string;
  visibility?: string;
  /** 空间绑定的本地文件夹路径（桌面端专用） */
  boundFolder?: string;
}

export interface SpaceState {
    currentSpaceId: string | null;
    currentSpace: SpaceData | null;
    memberSpaces: SpaceMemberWithSpaceInfo[] | null;
    loading: boolean;
    error?: string;
    /** Membership list freshness; reset on account switch. */
    membershipStatus: MembershipStatus;
    initialized: boolean;
    collapsedCategories: Record<string, boolean>;
    /** "全部"视图 vs "分类"视图 */
    viewMode: SpaceViewMode;
    /** 实时任务状态：dialogId → "running" | "done" | "failed" */
    dialogStatuses: Record<string, string>;
    /** 最近一次 dialog 事件时间，用于顶部通知排序 */
    dialogEventTimestamps: Record<string, number>;
    /** 运行时可用的 dialog 标题缓存 */
    dialogTitles: Record<string, string>;
    /** 第一层网页体验：后台完成/失败后给侧边栏一个未读提示点，进入该对话即清除 */
    unreadDialogIds: Record<string, boolean>;
}
