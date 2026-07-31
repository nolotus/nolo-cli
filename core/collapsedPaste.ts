/**
 * Shared helpers for collapsing oversized clipboard pastes in composers.
 *
 * When a paste is "large" (many lines or many chars), UIs should show a compact
 * chip/placeholder instead of flooding the input area. The full text stays in a
 * side store and is expanded back on send.
 */

export const COLLAPSE_PASTE_MIN_LINES = 8;
export const COLLAPSE_PASTE_MIN_CHARS = 400;

/** Stable placeholder: `[paste #12 · 345 lines]` */
export const COLLAPSED_PASTE_PLACEHOLDER_RE =
  /\[paste #(\d+) · (\d+) lines\]/g;

export type CollapsePasteThreshold = {
  minLines?: number;
  minChars?: number;
};

export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) lines += 1;
  }
  return lines;
}

export function shouldCollapsePaste(
  text: string,
  threshold: CollapsePasteThreshold = {},
): boolean {
  const minLines = threshold.minLines ?? COLLAPSE_PASTE_MIN_LINES;
  const minChars = threshold.minChars ?? COLLAPSE_PASTE_MIN_CHARS;
  if (text.length === 0) return false;
  if (text.length >= minChars) return true;
  return countTextLines(text) >= minLines;
}

export function formatPasteByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export function estimatePasteBytes(text: string): number {
  // UTF-8 byte length without allocating a TextEncoder in hot paths that only
  // need an approximate size label. Surrogate pairs and non-ASCII count as 2–3
  // via a simple heuristic: ASCII=1, else ~2 (good enough for a chip label).
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate — pair with next low surrogate as 4 UTF-8 bytes
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function formatCollapsedPastePlaceholder(
  id: number,
  text: string,
): string {
  const lines = countTextLines(text);
  return `[paste #${id} · ${lines} lines]`;
}

export type CollapsedPasteLabelLocale = "en" | "zh";

export function formatCollapsedPasteLabel(args: {
  id: number;
  text: string;
  locale?: CollapsedPasteLabelLocale;
}): string {
  const lines = countTextLines(args.text);
  const size = formatPasteByteSize(estimatePasteBytes(args.text));
  if (args.locale === "zh") {
    return `已粘贴文本 #${args.id} · ${lines} 行 · ${size}`;
  }
  return `Pasted text #${args.id} · ${lines} lines · ${size}`;
}

export type CollapsedPasteStore = {
  nextId: number;
  /** id → full pasted text */
  items: Map<number, string>;
};

export function createCollapsedPasteStore(): CollapsedPasteStore {
  return { nextId: 1, items: new Map() };
}

export function allocateCollapsedPaste(
  store: CollapsedPasteStore,
  text: string,
): { id: number; placeholder: string } {
  const id = store.nextId;
  store.nextId += 1;
  store.items.set(id, text);
  return { id, placeholder: formatCollapsedPastePlaceholder(id, text) };
}

export function releaseCollapsedPaste(
  store: CollapsedPasteStore,
  id: number,
): void {
  store.items.delete(id);
}

export function clearCollapsedPasteStore(store: CollapsedPasteStore): void {
  store.items.clear();
  store.nextId = 1;
}

/**
 * Expand all `[paste #N · … lines]` placeholders in `buffer` using `store`.
 * Unknown ids are left as-is so a user-typed lookalike is not destroyed.
 */
export function expandCollapsedPastes(
  buffer: string,
  store: CollapsedPasteStore,
): string {
  if (store.items.size === 0) return buffer;
  COLLAPSED_PASTE_PLACEHOLDER_RE.lastIndex = 0;
  return buffer.replace(COLLAPSED_PASTE_PLACEHOLDER_RE, (match, idRaw) => {
    const id = Number(idRaw);
    const full = store.items.get(id);
    return full === undefined ? match : full;
  });
}

/**
 * Expand `[start, end)` so any partially covered paste chip is included in full.
 * Keeps chips atomic across range deletes (Ctrl+U/K/W).
 */
export function expandRangeToCollapsedPasteChips(
  buffer: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.max(s, Math.max(start, end));
  if (s === e) return { start: s, end: e };

  COLLAPSED_PASTE_PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COLLAPSED_PASTE_PLACEHOLDER_RE.exec(buffer)) !== null) {
    const chipStart = match.index;
    const chipEnd = chipStart + match[0].length;
    if (chipStart < e && chipEnd > s) {
      if (chipStart < s) s = chipStart;
      if (chipEnd > e) e = chipEnd;
    }
  }
  return { start: s, end: e };
}

export type CollapsedPasteSpan = {
  id: number;
  start: number;
  end: number;
};

/** Find the placeholder span that contains `pos` (or ends at `pos` for backspace). */
export function findCollapsedPasteSpanAt(
  buffer: string,
  pos: number,
  opts: { preferLeft?: boolean } = {},
): CollapsedPasteSpan | null {
  COLLAPSED_PASTE_PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COLLAPSED_PASTE_PLACEHOLDER_RE.exec(buffer)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const inside = pos > start && pos < end;
    const atEnd = opts.preferLeft && pos === end;
    const atStart = !opts.preferLeft && pos === start;
    if (inside || atEnd || atStart) {
      return { id: Number(match[1]), start, end };
    }
  }
  return null;
}

/** Remove every placeholder whose id is missing from the store (orphan cleanup). */
export function stripOrphanCollapsedPastePlaceholders(
  buffer: string,
  store: CollapsedPasteStore,
): string {
  COLLAPSED_PASTE_PLACEHOLDER_RE.lastIndex = 0;
  return buffer.replace(COLLAPSED_PASTE_PLACEHOLDER_RE, (match, idRaw) => {
    const id = Number(idRaw);
    return store.items.has(id) ? match : "";
  });
}
