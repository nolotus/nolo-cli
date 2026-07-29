import { homedir as osHomedir } from "node:os";
import { clipCompactText } from "../core/clipCompactText";
import { compactWhitespace } from "../core/compactWhitespace";

/**
 * Path-aware clip: keeps the leading segment and the filename, eliding the
 * middle, so a long path stays identifiable. Non-path values fall back to the
 * shared tail clip.
 */
export function clipPathAware(value: string, max = 72): string {
  const compact = compactWhitespace(value);
  if (compact.length <= max) return compact;

  if (compact.includes(" ") || (!compact.includes("/") && !compact.includes("\\"))) {
    return clipCompactText(value, max, "…");
  }

  const segments = compact.split(/[/\\]/);
  const filename = segments[segments.length - 1];

  if (filename.length >= max) {
    return clipCompactText(value, max, "…");
  }

  const ELISION = "/…/";
  let prefix = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    const candidate = segments.slice(0, i + 1).join("/");
    if (candidate.length + ELISION.length + filename.length > max) break;
    prefix = candidate;
  }
  if (prefix) return `${prefix}${ELISION}${filename}`;

  const filenameOnly = `…/${filename}`;
  if (filenameOnly.length <= max) return filenameOnly;

  return clipCompactText(value, max, "…");
}

/**
 * Replace absolute home directory path (e.g. /Users/nolotus or /home/user) with ~
 */
export function formatHomePath(path: string, customHomedir?: string): string {
  if (!path) return "";
  const home = customHomedir || (typeof process !== "undefined" ? process.env?.HOME : undefined) || (typeof osHomedir === "function" ? osHomedir() : "");
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  // Generic fallback for Unix absolute paths like /Users/username/ or /home/username/
  return path.replace(/^(\/Users\/[^\/]+\/|\/home\/[^\/]+\/)/, "~/");
}

/**
 * Extract path and optional line selector from raw path or metadata.
 * e.g. "packages/cli/tui/sessionTypes.ts:2-49"
 */
export function formatReadItemPath(
  rawPath: string,
  metadata?: Record<string, unknown>,
  customHomedir?: string
): string {
  const inputPath =
    rawPath ||
    (typeof metadata?.path === "string" ? metadata.path : undefined) ||
    (typeof metadata?.filePath === "string" ? metadata.filePath : undefined) ||
    "file";

  let formattedPath = formatHomePath(inputPath, customHomedir);
  if (!formattedPath) return "file";

  let rangePart = "";
  const match = formattedPath.match(/(:[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*)$/);
  if (match) {
    rangePart = match[1];
    formattedPath = formattedPath.slice(0, -rangePart.length);
  } else if (
    metadata &&
    typeof metadata.startLine === "number" &&
    typeof metadata.endLine === "number" &&
    typeof metadata.totalLines === "number"
  ) {
    const { startLine, endLine, totalLines, truncated } = metadata;
    if (truncated || startLine !== 1 || endLine !== totalLines) {
      rangePart = `:${startLine}-${endLine}`;
    }
  }

  const clippedPath = clipPathAware(formattedPath, 72);
  return `${clippedPath}${rangePart}`;
}

export type ReadTreeItemInput = {
  path: string;
  metadata?: Record<string, unknown>;
};

/**
 * Format a list of read items into a tree representation matching:
 * • Read (N)
 * ├── ~/path/to/file1:2-49
 * └── ~/path/to/file2
 */
export function formatReadTreeLines(
  items: ReadTreeItemInput[],
  customHomedir?: string
): {
  header: string;
  count: number;
  lines: Array<{ connector: string; pathWithRange: string }>;
} {
  const count = items.length;
  const header = `Read (${count})`;
  const lines = items.map((item, index) => {
    const connector = index === items.length - 1 ? "└── " : "├── ";
    const pathWithRange = formatReadItemPath(item.path, item.metadata, customHomedir);
    return { connector, pathWithRange };
  });

  return { header, count, lines };
}

export type SearchTreeItemInput = {
  query: string;
  path?: string;
};

/**
 * Clean and clip query text for search tree items.
 */
export function formatSearchItemQuery(query: string, path?: string, customHomedir?: string): string {
  let text = (query || "").trim();
  if (path) {
    const formattedPath = formatHomePath(path, customHomedir);
    if (formattedPath) {
      text = text ? `${text} in ${formattedPath}` : formattedPath;
    }
  }
  if (!text) return "search";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Format a list of search items into a tree representation matching:
 * • Search (N)
 * ├── selectionStart|selectionEnd|setSelectionRange
 * └── contenteditable|textarea|onInput
 */
export function formatSearchTreeLines(
  items: SearchTreeItemInput[],
  customHomedir?: string
): {
  header: string;
  count: number;
  lines: Array<{ connector: string; queryText: string }>;
} {
  const count = items.length;
  const header = `Search (${count})`;
  const lines = items.map((item, index) => {
    const connector = index === items.length - 1 ? "└── " : "├── ";
    const queryText = formatSearchItemQuery(item.query, item.path, customHomedir);
    return { connector, queryText };
  });

  return { header, count, lines };
}

export type RunTreeItemInput = {
  command: string;
  exitCode?: number;
  timedOut?: boolean;
};

/**
 * Clip a shell command for the Run tree leaf. Commands can be long (pipelines,
 * multi-line scripts), so apply the shared compact-then-tail-clip. Unlike
 * paths there is no leading segment worth preserving, so plain tail clip is
 * the right call.
 */
export function formatRunItemCommand(
  command: string,
  exitCode?: number,
  timedOut?: boolean
): string {
  let text = compactWhitespace(command || "");
  if (!text) text = "command";
  text = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  // Surface actionable status inline on the leaf, mirroring the standalone
  // compact line's ✗/! markers. A clean exit (0) is the common case and stays
  // silent — same noise budget as readFile's read-range hint.
  if (timedOut) return `${text} (timed out)`;
  if (typeof exitCode === "number" && exitCode !== 0) return `${text} (exit ${exitCode})`;
  return text;
}

/**
 * Format a list of run items into a tree representation matching:
 * • Run (N)
 * ├── bun test tui/session.test.ts
 * └── git status -sb
 */
export function formatRunTreeLines(
  items: RunTreeItemInput[]
): {
  header: string;
  count: number;
  lines: Array<{ connector: string; commandText: string }>;
} {
  const count = items.length;
  const header = `Run (${count})`;
  const lines = items.map((item, index) => {
    const connector = index === items.length - 1 ? "└── " : "├── ";
    const commandText = formatRunItemCommand(item.command, item.exitCode, item.timedOut);
    return { connector, commandText };
  });

  return { header, count, lines };
}

export type FetchTreeItemInput = { url: string };

/**
 * Clip a webpage URL for the Fetch tree leaf. URLs can be long (query strings,
 * anchors), so apply the same compact-then-truncate as the search query leaf.
 */
export function formatFetchItemUrl(url: string): string {
  const text = (url || "").trim();
  if (!text) return "webpage";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Format a list of fetch items into a tree representation matching:
 * • Fetch (N)
 * ├── https://example.com/page1
 * └── https://example.com/page2
 */
export function formatFetchTreeLines(
  items: FetchTreeItemInput[]
): {
  header: string;
  count: number;
  lines: Array<{ connector: string; urlText: string }>;
} {
  const count = items.length;
  const header = `Fetch (${count})`;
  const lines = items.map((item, index) => {
    const connector = index === items.length - 1 ? "└── " : "├── ";
    const urlText = formatFetchItemUrl(item.url);
    return { connector, urlText };
  });

  return { header, count, lines };
}
