/**
 * Shared pure predicates for `image_url` content parts.
 *
 * Both the OpenCode Go payload rewrite (`bareImageUrlShape`) and provider
 * failure diagnosis (`providerFailureMessage`) need to recognise an image part
 * in an OpenAI-compatible message body. Keep one definition so "what counts as
 * an image part" cannot drift between them.
 *
 * Dependency-free so pure unit tests do not pull server/agent modules.
 */
import { isRecord } from "../isRecord";

/** An OpenAI-compatible `{ type: "image_url", … }` content part. */
export function isImageUrlPart(part: unknown): part is Record<string, unknown> {
  return isRecord(part) && part.type === "image_url";
}

/** Whether any message in a request carries an image part. */
export function hasImageParts(messages: readonly { content?: unknown }[]): boolean {
  return messages.some(
    (message) => Array.isArray(message.content) && message.content.some(isImageUrlPart),
  );
}
