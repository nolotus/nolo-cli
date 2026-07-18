import { toErrorMessage } from "../../core/errorMessage";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

const DOCS_HOST_RE = /^docs\./i;

export interface DocsIndexEntry {
  title: string;
  url: string;
  source: "llms.txt" | "llms-full.txt";
}

export interface DocsResolution {
  resolvedUrl: string;
  source: "original" | "llms.txt" | "llms-full.txt";
}

export interface ExtractionIssue {
  code: "EMPTY_EXTRACTION" | "HTML_SHELL";
  message: string;
}

export function extractAdvertisedMarkdownUrl(markdown: string, sourceUrl: string) {
  if (!markdown.trim()) return null;

  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return null;
  }

  const hintMatch = markdown.match(/Get this page as Markdown:\s*(https?:\/\/[^\s)]+)/i);
  const rawHint = hintMatch?.[1]?.trim();
  if (!rawHint) return null;

  try {
    const hinted = new URL(rawHint);
    if (hinted.origin !== source.origin) return null;
    if (!/\.md$/i.test(hinted.pathname)) return null;
    return hinted.toString();
  } catch {
    return null;
  }
}

function normalizePathname(pathname: string) {
  return pathname
    .replace(/\/index\.md$/i, "/")
    .replace(/\.md$/i, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function tokenize(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !["md", "html", "htm", "docs", "doc"].includes(part))
    )
  );
}

function splitNormalizedSegments(pathname: string) {
  const normalized = normalizePathname(pathname);
  return normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function segmentSignature(segment: string) {
  const tokens = tokenize(segment);
  if (tokens.length > 0) return tokens.join("-");
  return asTrimmedLowercaseString(segment);
}

function hasCompatiblePathStructure(requestedPath: string, candidatePath: string) {
  const requestedSegments = splitNormalizedSegments(requestedPath);
  const candidateSegments = splitNormalizedSegments(candidatePath);

  if (requestedSegments.length <= 1 || candidateSegments.length <= 1) {
    return true;
  }

  if (candidateSegments.length > requestedSegments.length) {
    return false;
  }

  for (let index = 1; index <= candidateSegments.length; index += 1) {
    const requestedSegment = requestedSegments.at(-index);
    const candidateSegment = candidateSegments.at(-index);
    if (!requestedSegment || !candidateSegment) return false;
    if (segmentSignature(requestedSegment) !== segmentSignature(candidateSegment)) {
      return false;
    }
  }

  return true;
}

function collectEntryTokens(entry: DocsIndexEntry) {
  const parsed = new URL(entry.url);
  return {
    pathTokens: tokenize(parsed.pathname),
    titleTokens: tokenize(entry.title),
    normalizedPath: normalizePathname(parsed.pathname),
  };
}

function normalizeCandidateUrl(rawUrl: string, baseUrl: string) {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isDocsHost(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    return DOCS_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function parseLlmsIndex(text: string, baseUrl: string): DocsIndexEntry[] {
  const entries: DocsIndexEntry[] = [];
  const linkRe = /-\s+\[([^\]]+)\]\(([^)]+)\)/g;

  for (const match of text.matchAll(linkRe)) {
    const title = match[1]?.trim();
    const rawUrl = match[2]?.trim();
    if (!title || !rawUrl) continue;
    const url = normalizeCandidateUrl(rawUrl, baseUrl);
    if (!url) continue;
    entries.push({ title, url, source: "llms.txt" });
  }

  return entries;
}

export function parseLlmsFullSources(text: string, baseUrl: string): DocsIndexEntry[] {
  const entries: DocsIndexEntry[] = [];
  const lines = text.split(/\r?\n/);
  let currentTitle = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("# ")) {
      currentTitle = line.slice(2).trim();
      continue;
    }

    if (!line.toLowerCase().startsWith("source:")) continue;

    const rawUrl = line.slice("source:".length).trim();
    const url = normalizeCandidateUrl(rawUrl, baseUrl);
    if (!url || !currentTitle) continue;
    entries.push({ title: currentTitle, url, source: "llms-full.txt" });
  }

  return entries;
}

function scoreDocsEntry(requestedUrl: URL, entry: DocsIndexEntry) {
  const requestedPath = normalizePathname(requestedUrl.pathname);
  const requestedTokens = tokenize(requestedUrl.pathname);
  const lastRequestedToken = requestedTokens.at(-1);
  const { pathTokens, titleTokens, normalizedPath } = collectEntryTokens(entry);

  if (requestedPath === normalizedPath) return 10_000;

  let score = 0;
  const unionTokens = new Set([...pathTokens, ...titleTokens]);

  for (const token of requestedTokens) {
    if (pathTokens.includes(token)) score += 3;
    if (titleTokens.includes(token)) score += 4;
  }

  if (lastRequestedToken) {
    if (pathTokens.at(-1) === lastRequestedToken) score += 10;
    if (titleTokens.includes(lastRequestedToken)) score += 4;
  }

  if (requestedTokens.length > 0 && requestedTokens.every((token) => unionTokens.has(token))) {
    score += 10;
  }

  score -= Math.abs(unionTokens.size - requestedTokens.length);
  return score;
}

export function resolveDocsUrlFromEntries(
  rawUrl: string,
  entries: DocsIndexEntry[]
): DocsResolution {
  const requestedUrl = new URL(rawUrl);
  const sameOriginEntries = entries.filter((entry) => {
    try {
      return new URL(entry.url).origin === requestedUrl.origin;
    } catch {
      return false;
    }
  });

  if (sameOriginEntries.length === 0) {
    return { resolvedUrl: rawUrl, source: "original" };
  }

  const ranked = sameOriginEntries
    .filter((entry) => hasCompatiblePathStructure(requestedUrl.pathname, new URL(entry.url).pathname))
    .map((entry) => ({
      entry,
      score: scoreDocsEntry(requestedUrl, entry),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 8) {
    return { resolvedUrl: rawUrl, source: "original" };
  }

  return {
    resolvedUrl: best.entry.url,
    source: best.entry.source,
  };
}

export async function discoverCanonicalDocsUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<DocsResolution> {
  if (!isDocsHost(rawUrl)) {
    return { resolvedUrl: rawUrl, source: "original" };
  }

  const parsed = new URL(rawUrl);
  const baseUrl = parsed.origin + "/";
  const entries: DocsIndexEntry[] = [];

  const llmsText = await fetchTextIfOk(new URL("/llms.txt", parsed.origin).toString(), fetchImpl);
  if (llmsText) {
    entries.push(...parseLlmsIndex(llmsText, baseUrl));
  }

  const fromLlms = resolveDocsUrlFromEntries(rawUrl, entries);
  if (fromLlms.source !== "original") {
    return fromLlms;
  }

  const llmsFullText = await fetchTextIfOk(
    new URL("/llms-full.txt", parsed.origin).toString(),
    fetchImpl
  );
  if (llmsFullText) {
    entries.push(...parseLlmsFullSources(llmsFullText, baseUrl));
  }

  return resolveDocsUrlFromEntries(rawUrl, entries);
}

async function fetchTextIfOk(url: string, fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "text/plain, text/markdown, text/html;q=0.8, */*;q=0.1" },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export async function assertFetchableDocsUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  originalUrl?: string
): Promise<void> {
  if (!isDocsHost(rawUrl)) return;

  try {
    const response = await fetchImpl(rawUrl, {
      method: "HEAD",
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });

    if (response.ok || response.status === 405 || response.status === 501) {
      return;
    }

    throw new Error(`文档页面返回 ${response.status}`);
  } catch (error) {
    const message = toErrorMessage(error);
    const rewriteHint =
      originalUrl && originalUrl !== rawUrl
        ? `原始地址 ${originalUrl} 已规范化为 ${rawUrl}，但规范化地址不可用。`
        : "";
    throw new Error(`访问网页失败：文档地址不可用 (${rawUrl})。${rewriteHint}${message}`);
  }
}

export function detectExtractionIssue(markdown: string, sourceUrl: string): ExtractionIssue | null {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return {
      code: "EMPTY_EXTRACTION",
      message: `访问网页失败：${sourceUrl} 未提取到正文内容。`,
    };
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("<!doctype html") ||
    lower.startsWith("<html") ||
    lower.includes("__next_error__")
  ) {
    return {
      code: "HTML_SHELL",
      message: `访问网页失败：${sourceUrl} 返回了错误页或 HTML 壳，而不是正文内容。`,
    };
  }

  return null;
}
