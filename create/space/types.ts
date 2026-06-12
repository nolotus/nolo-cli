import { SpaceData, SpaceMemberWithSpaceInfo } from "../../app/types";

export type SpaceId = string;

export type SpaceViewMode = "all" | "categories";

export interface CreateSpaceRequest { }

export interface SpaceState {
    currentSpaceId: string | null;
    currentSpace: SpaceData | null;
    memberSpaces: SpaceMemberWithSpaceInfo[] | null;
    loading: boolean;
    error?: string;
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
