// 用户内容查询不能简单假设所有 key 都是 `${type}-${userId}-...`。
// 例如 table 的真实 meta key 是 `meta-${userId}-${tableId}`，所以 query 层必须维护 type -> key prefix 的映射。
const TYPE_PREFIX_ALIASES: Record<string, string[]> = {
  table: ["meta"],
};

export function getUserDataPrefixes(type: string, userId: string): string[] {
  const normalizedType = String(type || "").trim();
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedType || !normalizedUserId) return [];

  const aliases = TYPE_PREFIX_ALIASES[normalizedType] ?? [normalizedType];
  return aliases.map((prefix) => `${prefix}-${normalizedUserId}`);
}
