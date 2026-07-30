export const TABLE_ACTIVITY_COLUMNS = ["meta.latestActivityRef", "meta.activityRefs"] as const;

export function includeTableActivityColumns(columns?: string[]): string[] | undefined {
  if (!Array.isArray(columns)) return [...TABLE_ACTIVITY_COLUMNS];
  return Array.from(new Set([...columns, ...TABLE_ACTIVITY_COLUMNS]));
}
