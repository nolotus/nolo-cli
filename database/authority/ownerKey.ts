import { asTrimmedString } from "../../core/trimmedString";

const USER_OWNED_SECOND_SEGMENT_PREFIXES = new Set([
  "agent",
  "dialog",
  "page",
  "doc",
  "notification",
  "email",
  "meta",
  "row",
  "view",
  "file",
  "job",
]);

const PUBLIC_OWNER_SENTINELS = new Set(["pub", "id", "stats", "index"]);

const cleanSegment = (value: string | undefined): string | null => {
  const trimmed = asTrimmedString(value);
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeCandidateOwners = (
  candidateOwnerUserIds: Array<string | null | undefined> | undefined
): string[] => {
  const out: string[] = [];
  for (const candidate of candidateOwnerUserIds ?? []) {
    const normalized = cleanSegment(candidate ?? undefined);
    if (!normalized || PUBLIC_OWNER_SENTINELS.has(normalized)) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out.sort((left, right) => right.length - left.length);
};

export const resolveCandidateOwnerFromKeyRemainder = (
  remainder: string,
  candidateOwnerUserIds: Array<string | null | undefined> | undefined
): string | null => {
  const normalizedRemainder = cleanSegment(remainder);
  if (!normalizedRemainder) return null;

  for (const candidate of normalizeCandidateOwners(candidateOwnerUserIds)) {
    if (
      normalizedRemainder === candidate ||
      normalizedRemainder.startsWith(`${candidate}-`)
    ) {
      return candidate;
    }
  }

  return null;
};

export const parseOwnerUserIdFromDbKey = (
  dbKey: string,
  options: {
    candidateOwnerUserIds?: Array<string | null | undefined>;
  } = {}
): string | null => {
  const normalized = cleanSegment(dbKey);
  if (!normalized) return null;

  const parts = normalized.split("-");
  const [prefix] = parts;
  if (!prefix) return null;
  if (!USER_OWNED_SECOND_SEGMENT_PREFIXES.has(prefix)) return null;

  // Dialog message keys: dialog-{dialogId}-msg-{messageId}.
  // dialogId is not the owner (align with server writeAuthority.resolveKeyOwnerId);
  // callers must fall through to record.userId / candidate context.
  if (parts[0] === "dialog" && parts[2] === "msg") {
    return null;
  }

  const ownerAndRest = normalized.slice(prefix.length + 1);
  const candidateOwner = resolveCandidateOwnerFromKeyRemainder(
    ownerAndRest,
    options.candidateOwnerUserIds
  );
  if (candidateOwner) return candidateOwner;

  const [owner] = ownerAndRest.split("-");
  const ownerUserId = cleanSegment(owner);
  if (!ownerUserId) return null;
  if (PUBLIC_OWNER_SENTINELS.has(ownerUserId)) return null;

  return ownerUserId;
};
