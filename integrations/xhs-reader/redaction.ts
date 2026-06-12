// XHS-specific sensitive value redaction.
// Follows patterns from x-reader/redaction.ts but adds XHS-specific token fields.

const XHS_SENSITIVE_KEY_PATTERN =
  /^(xsecToken|xsec_token|cookie|web_session|a1|webId|galaxy_sessionid|customerClientId|authorization|access_token|refresh_token|secret|token)$/i;

const XHS_COOKIE_PATTERN = /\b(a1|web_session|webId|galaxy_sessionid|customerClientId)=[^;\s]*/gi;

const XHS_URL_TOKEN_PATTERN = /([?&])xsec_token=[^&#]*/gi;

/**
 * Recursively redact XHS-sensitive values from any JSON-serializable object.
 * Redacts:
 * - Object keys matching XHS_SENSITIVE_KEY_PATTERN (value becomes "[REDACTED]")
 * - Cookie-like substrings within string values
 * - xsec_token URL params within string values
 */
export function redactXhsSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactXhsSensitiveValue(item));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (XHS_SENSITIVE_KEY_PATTERN.test(key)) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactXhsSensitiveValue(child);
      }
    }
    return redacted;
  }

  if (typeof value === "string") {
    let result = value;
    // Redact cookie-like patterns
    result = result.replace(XHS_COOKIE_PATTERN, (match) => {
      const eqIdx = match.indexOf("=");
      return eqIdx >= 0 ? `${match.slice(0, eqIdx + 1)}[REDACTED]` : "[REDACTED]";
    });
    // Redact xsec_token in URLs
    result = result.replace(XHS_URL_TOKEN_PATTERN, "$1xsec_token=[REDACTED]");
    return result;
  }

  return value;
}

/**
 * Check if a string contains any XHS-sensitive patterns.
 * Useful for assertions in tests.
 */
export function containsSensitiveValue(text: string): boolean {
  if (XHS_COOKIE_PATTERN.test(text)) {
    // Reset regex state for subsequent calls
    XHS_COOKIE_PATTERN.lastIndex = 0;
    return true;
  }
  if (XHS_URL_TOKEN_PATTERN.test(text)) {
    XHS_URL_TOKEN_PATTERN.lastIndex = 0;
    return true;
  }
  // Check for raw xsecToken-looking values
  if (/xsecToken['":\s]*[:=]/i.test(text)) return true;
  if (/xsec_token['":\s]*[:=]/i.test(text)) return true;
  return false;
}
