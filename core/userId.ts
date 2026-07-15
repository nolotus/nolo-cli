import { asTrimmedString } from "./trimmedString";

/**
 * Shared pure user-id normalizer for bare vs `user:` record-key forms.
 *
 * Share indexes, creator pages, account-deletion matchers, and similar readers
 * accept either a bare user id or the `user:{id}` Level key form. Collapse to
 * the bare id so ownership comparisons and index keys cannot drift.
 *
 * Non-strings coerce via `asTrimmedString` (empty). Dependency-free pure tests
 * do not pull share/auth modules.
 */
export function normalizeUserId(value: unknown): string {
  const text = asTrimmedString(value);
  return text.startsWith("user:") ? text.slice("user:".length) : text;
}
