export type FavoriteTargetType = "agent" | "content" | "page" | "doc" | "file";

export interface ToggleFavoriteParams {
  targetType: FavoriteTargetType;
  /**
   * 当前阶段约定为完整 dbKey（例如 "agent-xxx" / "page-xxx" / "meta-xxx" / "image-xxx"）。
   * TODO: 如果以后要支持按逻辑 AgentId 收藏，可以新增一个字段：
   *       - targetId?: string (逻辑ID)
   *       或者再拆出一个单独的 RPC。
   */
  targetKey: string;
}
export interface ToggleFavoriteResult {
  targetType: FavoriteTargetType;
  targetKey: string;
  isFavorite: boolean;
  /** 当前该对象被多少人收藏（按 stats 计算） */
  favoriteCount: number;
}

export interface SetFavoriteParams extends ToggleFavoriteParams {
  isFavorite: boolean;
  favoritedAt?: number;
}

export type SetFavoriteResult = ToggleFavoriteResult;

export interface ListFavoritesParams {
  targetType: FavoriteTargetType | FavoriteTargetType[];
}

export interface FavoriteListItem {
  id: string;
  favoritedAt: number;
}

export interface ListFavoritesResult {
  targetType: FavoriteTargetType;
  /** 当前用户收藏的该类型对象的 key 列表 */
  ids: string[];
  /** 收藏时间（毫秒时间戳） */
  items?: FavoriteListItem[];
}
