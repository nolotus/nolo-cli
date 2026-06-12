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
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
};

const normalizeUserId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readEntryAuthorityServer = (
  entry: UserAuthorityRegistryEntry | undefined
): string | null => {
  if (typeof entry === "string") {
    return normalizeAuthorityServerOrigin(entry);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
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
