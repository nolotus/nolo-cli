import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { normalizeServerOrigin } from "../../core/serverOrigin";

export type UserAuthorityRegistryEntry =
  | string
  | {
      authorityServer?: unknown;
      homeServer?: unknown;
      primaryServer?: unknown;
      servers?: unknown;
    };

export type UserAuthorityRegistry = Record<string, UserAuthorityRegistryEntry>;

export const normalizeAuthorityServerOrigin = (value: unknown): string | null => {
  const normalized = normalizeServerOrigin(value);
  return /^https?:\/\//i.test(normalized) ? normalized : null;
};

const normalizeUserId = (value: unknown): string | null =>
  asOptionalTrimmedString(value) ?? null;

const readEntryAuthorityServer = (
  entry: UserAuthorityRegistryEntry | undefined
): string | null => {
  if (typeof entry === "string") {
    return normalizeAuthorityServerOrigin(entry);
  }
  if (!isRecord(entry)) {
    return null;
  }

  return (
    normalizeAuthorityServerOrigin(entry.authorityServer) ??
    normalizeAuthorityServerOrigin(entry.homeServer) ??
    normalizeAuthorityServerOrigin(entry.primaryServer)
  );
};

export const resolveUserAuthorityServer = ({
  ownerUserId,
  registry,
}: {
  ownerUserId?: string | null;
  registry?: UserAuthorityRegistry | null;
}): string | null => {
  const normalizedOwner = normalizeUserId(ownerUserId);
  if (!normalizedOwner || !registry || typeof registry !== "object") {
    return null;
  }

  return readEntryAuthorityServer(registry[normalizedOwner]);
};
