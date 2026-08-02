/**
 * Shared shaping for fetchWebpage results.
 *
 * Two call sites produce fetchWebpage output: the server route
 * (packages/server/handlers/fetchWebpageHandler.ts, used for public URLs) and
 * the CLI's in-process path (packages/cli/client/fetchWebpageContent.ts, used
 * for loopback/private URLs that must never leave the user's machine). The
 * model must see the same result shape regardless of which one ran, so the
 * cleaning rules and truncation bounds live here rather than in either caller.
 *
 * SSRF policy is deliberately NOT here — that belongs to the server route,
 * which is the only side where fetching a private address is an attack.
 */
import { compactWhitespace } from "./compactWhitespace";

export const FETCH_WEBPAGE_PREVIEW_LENGTH = 1200;
export const FETCH_WEBPAGE_MAX_CONTENT_LENGTH = 12 * 1024;

export const FETCH_WEBPAGE_REQUEST_HEADERS = {
  Accept: "text/markdown, text/html, application/xhtml+xml, */*",
  "User-Agent": "NoloBot/1.0 (AI Agent; +https://nolo.ai)",
} as const;

/** Strip script/style/tags and collapse whitespace so the model gets prose. */
export function cleanHtmlForAI(html: string): string {
  return compactWhitespace(
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<[^>]*>/g, " "),
  );
}

/**
 * Build the preview/fullContent pair. Bounded so a whole page cannot be
 * re-fed into every round of a multi-turn agent loop.
 */
export function shapeFetchWebpageContent(args: {
  content: string;
  contentType: string;
  markdownTokens?: string | null;
}): {
  preview: string;
  fullContent: string;
  contentType: string;
  markdownTokens: string | null;
} {
  const cleanedContent = args.contentType.includes("text/markdown")
    ? args.content.trim()
    : cleanHtmlForAI(args.content);

  const preview =
    cleanedContent.length > FETCH_WEBPAGE_PREVIEW_LENGTH
      ? cleanedContent.substring(0, FETCH_WEBPAGE_PREVIEW_LENGTH) +
        "...（预览内容已截断）"
      : cleanedContent;
  const fullContent =
    cleanedContent.length > FETCH_WEBPAGE_MAX_CONTENT_LENGTH
      ? cleanedContent.substring(0, FETCH_WEBPAGE_MAX_CONTENT_LENGTH) +
        "...（完整内容已截断）"
      : cleanedContent;

  return {
    preview,
    fullContent,
    contentType: args.contentType,
    markdownTokens: args.markdownTokens ?? null,
  };
}
