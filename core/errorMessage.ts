/**
 * Shared pure unknown-error → string message coercer.
 *
 * Logging, broker error envelopes, and auth/DB failure paths coerce thrown
 * values the same way: keep `Error.message`, prefer duck-typed string
 * `message` on plain objects (e.g. ApiError `{ code, message }`), otherwise
 * stringify.
 *
 * Keep one definition so Error vs non-Error / null / object handling cannot
 * drift across server and auth modules.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}
