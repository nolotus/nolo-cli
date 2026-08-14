/**
 * Pure 1-based inclusive line-range arithmetic shared by the read-tool dedup
 * ledgers (readFile / readPastedText).
 *
 * The ledgers record the line ranges a read tool has fully delivered this
 * session so a repeated read of an unchanged, still-in-context range can be
 * answered with a short notice instead of resending the content — the
 * code-layer half of "read once, re-read only when something changed".
 */

export type LineRange = { startLine: number; endLine: number };

/** A fully delivered read, measured in persisted provider-message chars. */
export type LedgerRecord = LineRange & { chars: number };

/** Per-source (file path / paste id) ledger entry. */
export type LedgerEntry = { fingerprint: string; records: LedgerRecord[] };

/**
 * Records small enough to survive historical projection intact — the only
 * ones a dedup gate may treat as "still in context".
 */
export function filterRetainedLedgerRecords(
  records: LedgerRecord[],
  retainedCap: number,
): LedgerRecord[] {
  return records.filter((record) => record.chars <= retainedCap);
}

function isValidRange(range: LineRange): boolean {
  return (
    Number.isInteger(range.startLine) &&
    Number.isInteger(range.endLine) &&
    range.endLine >= range.startLine
  );
}

/** Sort and coalesce overlapping or adjacent ranges. */
export function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges
    .filter(isValidRange)
    .slice()
    .sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine);
    } else {
      merged.push({ startLine: range.startLine, endLine: range.endLine });
    }
  }
  return merged;
}

/** True when every line of `request` falls inside the union of `covered`. */
export function isLineRangeCovered(
  request: LineRange,
  covered: LineRange[],
): boolean {
  if (!isValidRange(request)) return false;
  let open = request.startLine;
  for (const range of mergeLineRanges(covered)) {
    if (range.endLine < open) continue;
    if (range.startLine > open) return false;
    open = range.endLine + 1;
    if (open > request.endLine) return true;
  }
  return open > request.endLine;
}
