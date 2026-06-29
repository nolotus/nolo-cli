import { createHash, randomBytes } from "node:crypto";

import type { PkcePair } from "./types";

export const PKCE_VERIFIER_LENGTH = 64;

export function generatePkceVerifier(length = PKCE_VERIFIER_LENGTH): string {
  if (length < 43 || length > 128) {
    throw new Error("PKCE verifier length must be between 43 and 128 characters.");
  }
  return randomBytes(length)
    .toString("base64url")
    .slice(0, length);
}

export function computePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkcePair(length = PKCE_VERIFIER_LENGTH): PkcePair {
  const verifier = generatePkceVerifier(length);
  return {
    verifier,
    challenge: computePkceChallenge(verifier),
    method: "S256",
  };
}
