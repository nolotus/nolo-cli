/**
 * Provider-approved encrypted cloud credential grant skeleton (M6 stub).
 *
 * Real encrypted vault upload is intentionally deferred. This module only:
 * - defines grant types
 * - enforces an explicit ToS gate (default deny)
 * - refuses any network secret upload path
 */

import { asOptionalPositiveFiniteNumber } from "../core/optionalPositiveNumber";

export type CloudCredentialGrantStatus =
  | "denied"
  | "pending"
  | "active"
  | "revoked";

export type CloudCredentialGrant = {
  accountUserId: string;
  provider: string;
  status: CloudCredentialGrantStatus;
  tosAcceptedAt: number | null;
};

export type AssertCloudGrantAllowedInput = {
  accountUserId?: string | null;
  provider?: string | null;
  /** Explicit user acceptance of the provider ToS for cloud custody. */
  tosAccepted?: boolean | null;
  tosAcceptedAt?: number | string | null;
};

export type CreateCloudCredentialGrantInput = AssertCloudGrantAllowedInput & {
  status?: Exclude<CloudCredentialGrantStatus, "denied">;
  now?: () => number;
};

export class CloudGrantDeniedError extends Error {
  readonly code = "CLOUD_GRANT_DENIED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CloudGrantDeniedError";
  }
}

export class CloudGrantNotImplementedError extends Error {
  readonly code = "CLOUD_GRANT_NOT_IMPLEMENTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CloudGrantNotImplementedError";
  }
}

const normalizeRequired = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new CloudGrantDeniedError(`${field} is required for cloud credential grant`);
  }
  return value.trim();
};

const parseTosAcceptedAt = (value: unknown): number | null => {
  const asNumber = asOptionalPositiveFiniteNumber(value);
  if (asNumber !== undefined) return asNumber;
  if (typeof value === "string" && value.trim()) {
    return asOptionalPositiveFiniteNumber(Date.parse(value)) ?? null;
  }
  return null;
};

/**
 * Default-deny gate: cloud custody requires an explicit ToS accept
 * (`tosAccepted: true` and/or a positive `tosAcceptedAt`). No network side effects.
 */
export function assertCloudGrantAllowed(input: AssertCloudGrantAllowedInput = {}): void {
  normalizeRequired(input.accountUserId, "accountUserId");
  normalizeRequired(input.provider, "provider");

  if (input.tosAccepted === false) {
    throw new CloudGrantDeniedError(
      "provider Terms of Service acceptance is required for cloud credential custody"
    );
  }

  const tosAcceptedAt = parseTosAcceptedAt(input.tosAcceptedAt);
  const explicitAccept = input.tosAccepted === true;

  if (!explicitAccept && tosAcceptedAt == null) {
    throw new CloudGrantDeniedError(
      "provider Terms of Service must be explicitly accepted before cloud credential custody"
    );
  }
}

/**
 * Create a local grant record after ToS gate. Does not upload secrets or call
 * any network API — vault write remains future work.
 */
export function createCloudCredentialGrant(
  input: CreateCloudCredentialGrantInput
): CloudCredentialGrant {
  assertCloudGrantAllowed(input);

  const now = input.now ?? Date.now;
  const tosAcceptedAt =
    parseTosAcceptedAt(input.tosAcceptedAt) ??
    (input.tosAccepted === true ? now() : null);

  if (tosAcceptedAt == null) {
    // assertCloudGrantAllowed should have already thrown; keep fail-closed.
    throw new CloudGrantDeniedError(
      "provider Terms of Service must be explicitly accepted before cloud credential custody"
    );
  }

  return {
    accountUserId: String(input.accountUserId).trim(),
    provider: String(input.provider).trim(),
    status: input.status ?? "pending",
    tosAcceptedAt,
  };
}

/**
 * Stub: encrypted vault upload is not implemented. Intentionally performs no
 * network I/O so secrets cannot leave the device through this API.
 */
export function uploadCloudCredentialGrant(_args: {
  grant: CloudCredentialGrant;
  /** Placeholder only — real vault will take a broker credential ref, never raw secrets in logs. */
  credentialRef?: string;
  fetchImpl?: typeof fetch;
}): never {
  // Fail closed before any optional fetchImpl could run.
  throw new CloudGrantNotImplementedError(
    "encrypted cloud credential vault upload is not implemented (M6 stub)"
  );
}

export function isCloudGrantActive(grant: CloudCredentialGrant | null | undefined): boolean {
  return Boolean(
    grant &&
      grant.status === "active" &&
      typeof grant.tosAcceptedAt === "number" &&
      grant.tosAcceptedAt > 0
  );
}
