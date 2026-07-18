import { toTrimmedString } from "../core/toTrimmedString";

// 用户内容查询不能简单假设所有 key 都是 `${type}-${userId}-...`。
// 例如 table 的真实 meta key 是 `meta-${userId}-${tableId}`，所以 query 层必须维护 type -> key prefix 的映射。
//
// 返回值一律带尾部分隔符 `-`，供 gte/lte 组成 user-scoped range：
//   gte: `${prefix}`  (= `meta-u1-`)
//   lte: `${prefix}\uffff`
// 这样不会把 `meta-u10-...` 等「userId 字符串前缀邻居」扫进来（见 keys.metaKey.rangeOfTenant）。
const TYPE_PREFIX_ALIASES: Record<string, string[]> = {
  // table 定义存在 meta- 下，而不是 table- 下；不要同时扫 table-（空扫 / 错误布局）
  table: ["meta"],
};

/**
 * Resolve iterator prefixes for a user-scoped content type query.
 *
 * - Empty type / userId → []
 * - Aliases are deduped and empty alias segments skipped
 * - Each prefix ends with `-` (user boundary) so range scans stay user-scoped
 */
export function getUserDataPrefixes(type: string, userId: string): string[] {
  const normalizedType = toTrimmedString(type);
  const normalizedUserId = toTrimmedString(userId);
  if (!normalizedType || !normalizedUserId) return [];

  const aliases = TYPE_PREFIX_ALIASES[normalizedType] ?? [normalizedType];
  const seen = new Set<string>();
  const prefixes: string[] = [];

  for (const raw of aliases) {
    const alias = toTrimmedString(raw);
    if (!alias) continue;
    // Canonical form matches keys.ts rangeOfUser / rangeOfTenant starts.
    const prefix = `${alias}-${normalizedUserId}-`;
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    prefixes.push(prefix);
  }

  return prefixes;
}
