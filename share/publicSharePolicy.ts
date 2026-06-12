const EXPLICIT_PUBLIC_SHARE_PATTERNS = [
  "社区分享",
  "公开分享",
  "分享链接",
  "分享到社区",
  "发布到社区",
  "share link",
  "share to community",
  "public share",
  "publish publicly",
  "publish to community",
] as const;

const normalizeUserInput = (value: unknown): string =>
  typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
    : "";

export const hasExplicitPublicShareRequest = (value: unknown): boolean => {
  const normalized = normalizeUserInput(value);
  if (!normalized) return false;
  return EXPLICIT_PUBLIC_SHARE_PATTERNS.some((pattern) => normalized.includes(pattern));
};
