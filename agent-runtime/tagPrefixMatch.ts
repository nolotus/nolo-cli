/**
 * Shared helper for streaming tag parsers (thinkTagParser, toolCallTextParser).
 *
 * Returns the length of the longest suffix of `buffer` that is also a prefix
 * of `tag`. Used to keep only the bytes that could complete a tag when a
 * streaming chunk ends mid-tag.
 */
export function longestTagPrefixLength(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(buffer.slice(-len))) {
      return len;
    }
  }
  return 0;
}