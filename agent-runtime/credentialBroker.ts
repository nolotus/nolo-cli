/**
 * Local-first OS credential broker contract.
 *
 * Security rules:
 * - Least privilege: get/put/delete/has by explicit ref only.
 * - Never expose a dump-all / list-secrets API (secrets stay out of Redux, logs, URLs).
 * - Broker is device-local and OS-user scoped; cloud vault is out of scope (M6).
 */

/** Opaque credential reference (e.g. `api-key:agent-foo` or source-owned id). */
export type CredentialRef = string;

/**
 * Per-ref credential broker. Implementations must not provide bulk secret export.
 */
export type CredentialBroker = {
  get(ref: CredentialRef): Promise<string | null> | string | null;
  put(ref: CredentialRef, secret: string): Promise<void> | void;
  delete(ref: CredentialRef): Promise<void> | void;
  has(ref: CredentialRef): Promise<boolean> | boolean;
};

export function assertCredentialRef(ref: CredentialRef): string {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) {
    // Stable code for external surfaces — never echo the raw ref value.
    throw new Error("invalid_ref");
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("invalid_ref");
  }
  return trimmed;
}
