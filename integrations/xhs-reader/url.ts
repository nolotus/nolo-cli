import type { XhsParsedProfileUrl, XhsParsedNoteUrl } from "./types";

const PROFILE_RE =
  /(?:(?:https?:\/\/)?(?:www\.)?xiaohongshu\.com)?\/user\/profile\/([a-f0-9]{24})(?:\?[^#]*)?/i;

const NOTE_RE =
  /(?:(?:https?:\/\/)?(?:www\.)?xiaohongshu\.com)?\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\?[^#]*)?/i;

/**
 * Parse a XHS profile URL and return userId + canonical URL.
 * Accepts full URLs and path-only forms.
 * The xsecToken query param is preserved in the result for internal navigation only.
 */
export function parseXhsProfileUrl(input: string): XhsParsedProfileUrl {
  const match = input.match(PROFILE_RE);
  if (!match) {
    throw new Error(`Invalid XHS profile URL: ${input}`);
  }
  const userId = match[1];
  const canonicalUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;

  let xsecToken: string | undefined;
  let xsecSource: string | undefined;
  try {
    const urlObj = new URL(input.startsWith("http") ? input : `https://www.xiaohongshu.com${input}`);
    xsecToken = urlObj.searchParams.get("xsec_token") ?? undefined;
    xsecSource = urlObj.searchParams.get("xsec_source") ?? undefined;
  } catch {
    // The regex validation above already accepted path-like input; keep canonical navigation.
  }

  const navigationUrl = new URL(canonicalUrl);
  if (xsecToken) navigationUrl.searchParams.set("xsec_token", xsecToken);
  if (xsecSource) navigationUrl.searchParams.set("xsec_source", xsecSource);

  return {
    userId,
    canonicalUrl,
    navigationUrl: navigationUrl.toString(),
    xsecToken,
    xsecSource,
  };
}

/**
 * Parse a XHS note URL and return noteId + canonical URL.
 * The xsecToken query param is preserved in the result for internal use only.
 */
export function parseXhsNoteUrl(input: string): XhsParsedNoteUrl {
  const match = input.match(NOTE_RE);
  if (!match) {
    throw new Error(`Invalid XHS note URL: ${input}`);
  }
  const noteId = match[1];

  // Extract xsec_token if present (internal use only)
  let xsecToken: string | undefined;
  let xsecSource: string | undefined;
  try {
    const urlObj = new URL(input.startsWith("http") ? input : `https://www.xiaohongshu.com${input}`);
    xsecToken = urlObj.searchParams.get("xsec_token") ?? undefined;
    xsecSource = urlObj.searchParams.get("xsec_source") ?? undefined;
  } catch {
    // ignore parse errors
  }

  return {
    noteId,
    canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    xsecToken,
    xsecSource,
  };
}

/**
 * Validate that a string looks like a valid XHS note ID (24 hex chars).
 */
export function isValidXhsId(id: string): boolean {
  return /^[a-f0-9]{24}$/i.test(id);
}
