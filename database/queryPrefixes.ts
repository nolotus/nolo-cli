import { toTrimmedString } from "../core/toTrimmedString";
import { TYPE_STORAGE_PREFIXES } from "./keys";

// Type → Storage Prefix 映射的唯一定义在 keys.ts 的 TYPE_STORAGE_PREFIXES。
// queryPrefixes 只负责把它展开成 user-scoped 的 LevelDB range prefix。
//
// 返回值一律带尾部分隔符 `-`，供 gte/lte 组成 user-scoped range：
//   gte: `${prefix}`  (= `meta-u1-`)
//   lte: `${prefix}\uffff`
// 这样不会把 `meta-u10-...` 等「userId 字符串前缀邻居」扫进来（见 keys.metaKey.rangeOfTenant）。

/**
 * Resolve iterator prefixes for a user-scoped content type query.
 *
 * - Empty type / userId → []
 * - Prefixes come from TYPE_STORAGE_PREFIXES (keys.ts), falling back to [type]
 *   for unregistered types
 * - Aliases are deduped and empty segments skipped
 * - Each prefix ends with `-` (user boundary) so range scans stay user-scoped
 */
export function getUserDataPrefixes(type: string, userId: string): string[] {
  const normalizedType = toTrimmedString(type);
  const normalizedUserId = toTrimmedString(userId);
  if (!normalizedType || !normalizedUserId) return [];

  const aliases = TYPE_STORAGE_PREFIXES[normalizedType] ?? [normalizedType];
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