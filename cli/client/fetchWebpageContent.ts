/**
 * CLI-side fetchWebpage routing.
 *
 * fetchWebpage normally bridges to the server route, which correctly refuses
 * loopback/private hosts (a server fetching 127.0.0.1 hits itself — textbook
 * SSRF). But when the CLI runs on the user's own machine, `localhost:13882`
 * means *their* dev server, and that request should never leave the box. So
 * private/loopback targets are fetched in-process here and public ones keep
 * bridging.
 *
 * Content shaping (HTML cleaning, preview/full truncation, request headers)
 * comes from core/fetchWebpageShaping, shared with the server handler, so both
 * paths hand the model an identical result shape.
 */
import {
  FETCH_WEBPAGE_REQUEST_HEADERS,
  shapeFetchWebpageContent,
} from "../../core/fetchWebpageShaping";
import { isInternalHostname } from "../../core/internalHostname";
import type { CliFetchImpl } from "../cliFetch";


/**
 * Decide whether fetchWebpage should run in-process (private/loopback) or
 * bridge to the server (public http(s)). Non-http(s) is rejected.
 */
export function classifyFetchWebpageUrl(
  rawUrl: unknown,
):
  | { kind: "local"; url: string; parsed: URL }
  | { kind: "remote"; url: string; parsed: URL }
  | { kind: "reject"; error: string } {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { kind: "reject", error: "URL 参数是必需的" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "reject", error: "无效的 URL 格式" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "reject", error: "仅支持 HTTP/HTTPS 协议" };
  }
  if (isInternalHostname(parsed.hostname)) {
    return { kind: "local", url: rawUrl, parsed };
  }
  return { kind: "remote", url: rawUrl, parsed };
}

/** In-process fetch for private/loopback URLs; same JSON shape as the server bridge. */
export async function fetchWebpageLocally(args: {
  url: string;
  fetchImpl: CliFetchImpl;
}): Promise<string> {
  const response = await args.fetchImpl(args.url, {
    headers: { ...FETCH_WEBPAGE_REQUEST_HEADERS },
  });
  const contentType = response.headers.get("content-type") || "";
  const content = await response.text();
  const shaped = shapeFetchWebpageContent({
    content,
    contentType,
    markdownTokens: response.headers.get("x-markdown-tokens"),
  });
  return JSON.stringify(shaped);
}
