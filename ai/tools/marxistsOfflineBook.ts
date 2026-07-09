export type MarxistsOfflineBookPage = {
  name: string;
  url: string;
  title: string;
};

export type MarxistsOfflineBookResult = {
  title: string;
  startUrl: string;
  indexUrl: string;
  stylesheetUrl: string | null;
  pages: MarxistsOfflineBookPage[];
  html: string;
  validation: {
    pageCount: number;
    hasEmbeddedAssets: boolean;
    hasNetworkUrls: boolean;
    hasUtf8Meta: boolean;
    byteLength: number;
  };
};

export type ConvertMarxistsBookArgs = {
  startUrl: string;
  encoding?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxPages?: number;
};

const DEFAULT_ENCODING = "gb2312";
const USER_AGENT =
  "Mozilla/5.0 (compatible; NoloMarxistsOfflineBook/1.0; +https://nolo.chat)";

const normalizeBookBaseUrl = (startUrl: string): URL => {
  const parsed = new URL(startUrl);
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("startUrl must be an http or https URL.");
  }
  return new URL("./", parsed);
};

const decodeBytes = (bytes: ArrayBuffer, encoding: string): string => {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder(DEFAULT_ENCODING).decode(bytes);
  }
};

const fetchBytes = async (
  url: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<ArrayBuffer> => {
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
};

const extractTitle = (html: string): string => {
  return (
    html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || ""
  );
};

const extractBody = (html: string): string => {
  return html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
};

export const discoverMarxistsBookPageNames = (
  indexHtml: string,
  maxPages = 80,
): string[] => {
  const pageNames = [...indexHtml.matchAll(/href=["']?([^"' >#]+\.htm)(#[^"' >]*)?["']?/gi)]
    .map((match) => match[1])
    .filter((href) => !href.includes("/") && !href.startsWith(".."))
    .map((href) => href.trim())
    .filter(Boolean)
    .sort();

  const uniqueNames = Array.from(new Set(["index.htm", ...pageNames]));
  if (uniqueNames.length <= 1) {
    throw new Error("No same-directory .htm chapter links were found in index.htm.");
  }
  if (uniqueNames.length > maxPages) {
    throw new Error(
      `Refusing to download ${uniqueNames.length} pages; maxPages is ${maxPages}.`,
    );
  }
  return uniqueNames;
};

const extractStylesheetHref = (html: string): string | null => {
  return (
    html.match(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/i)?.[1] ?? null
  );
};

const guessMimeType = (url: string): string => {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".css")) return "text/css";
  return "application/octet-stream";
};

export const inlineCssUrlAssets = async (args: {
  css: string;
  cssUrl: string;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<string> => {
  const replacements = new Map<string, string>();
  const matches = [...args.css.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)];

  for (const match of matches) {
    const rawRef = match[2].trim();
    if (!rawRef || /^(data:|https?:)/i.test(rawRef)) continue;
    const assetUrl = new URL(rawRef, args.cssUrl).toString();
    if (!replacements.has(rawRef)) {
      const bytes = await fetchBytes(assetUrl, args.fetchImpl);
      const base64 = Buffer.from(bytes).toString("base64");
      replacements.set(
        rawRef,
        `data:${guessMimeType(assetUrl)};base64,${base64}`,
      );
    }
  }

  return args.css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (full, quote, rawRef) => {
    const replacement = replacements.get(String(rawRef).trim());
    return replacement ? `url('${replacement}')` : full;
  });
};

const rewriteLocalChapterLinks = (body: string): string => {
  return body.replace(
    /href=["']([^"']+\.htm)(#[^"']*)?["']/gi,
    (_full, href: string, hash: string | undefined) => {
      const anchor = href.replace(/\.htm$/i, "");
      return `href="#${anchor}${hash ? `-${hash.replace(/^#/, "")}` : ""}"`;
    },
  );
};

const buildSingleHtml = (args: {
  title: string;
  css: string;
  pages: Array<MarxistsOfflineBookPage & { body: string }>;
}): string => {
  const sections = args.pages.map((page) => {
    const anchor = page.name.replace(/\.htm$/i, "");
    return `<section class="chapter" id="${anchor}"><div class="chapter-source">${page.title}</div>${rewriteLocalChapterLinks(page.body)}</section>`;
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${args.title}</title>
<style>
${args.css}
body { margin: 0 10px; }
.table1 { max-width: 960px; width: min(960px, calc(100vw - 20px)); }
.chapter { page-break-after: always; break-after: page; }
.chapter-source { display: none; }
@media screen and (max-width: 700px) {
  html { margin-left: 8px !important; margin-right: 8px !important; }
  body { margin-left: 8px !important; margin-right: 8px !important; }
  .table1 { width: 100% !important; max-width: 100% !important; }
  table { max-width: 100% !important; }
}
@media print {
  .chapter { page-break-after: always; }
}
</style>
</head>
<body id="top">
${sections.join("\n")}
</body>
</html>`;
};

export async function convertMarxistsBookToOfflineHtml(
  args: ConvertMarxistsBookArgs,
): Promise<MarxistsOfflineBookResult> {
  const startUrl = args.startUrl?.trim();
  if (!startUrl) throw new Error("startUrl is required.");

  const fetchImpl = args.fetchImpl ?? fetch;
  const encoding = args.encoding || DEFAULT_ENCODING;
  const bookBaseUrl = normalizeBookBaseUrl(startUrl);
  const indexUrl = new URL("index.htm", bookBaseUrl).toString();
  const indexHtml = decodeBytes(await fetchBytes(indexUrl, fetchImpl), encoding);
  const pageNames = discoverMarxistsBookPageNames(indexHtml, args.maxPages);

  const pages: Array<MarxistsOfflineBookPage & { body: string }> = [];
  for (const name of pageNames) {
    const pageUrl = new URL(name, bookBaseUrl).toString();
    const html = decodeBytes(await fetchBytes(pageUrl, fetchImpl), encoding);
    pages.push({
      name,
      url: pageUrl,
      title: extractTitle(html),
      body: extractBody(html),
    });
  }

  const stylesheetHref =
    extractStylesheetHref(indexHtml) ||
    pages.map((page) => extractStylesheetHref(page.body)).find(Boolean) ||
    "../../MIA01.css";
  const stylesheetUrl = stylesheetHref
    ? new URL(stylesheetHref, indexUrl).toString()
    : null;
  const rawCss = stylesheetUrl
    ? decodeBytes(await fetchBytes(stylesheetUrl, fetchImpl), encoding)
    : "";
  const css = stylesheetUrl
    ? await inlineCssUrlAssets({ css: rawCss, cssUrl: stylesheetUrl, fetchImpl })
    : rawCss;

  const title = extractTitle(indexHtml) || pages[0]?.title || "Offline Book";
  const html = buildSingleHtml({ title, css, pages });
  const byteLength = new TextEncoder().encode(html).byteLength;

  return {
    title,
    startUrl,
    indexUrl,
    stylesheetUrl,
    pages: pages.map(({ body: _body, ...page }) => page),
    html,
    validation: {
      pageCount: pages.length,
      hasEmbeddedAssets: html.includes("data:image/"),
      hasNetworkUrls: /https?:\/\//i.test(html),
      hasUtf8Meta: html.includes('<meta charset="utf-8">'),
      byteLength,
    },
  };
}
