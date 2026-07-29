import { normalizeSpaceId } from "../../create/space/spaceKeys";

export type DeleteSpacesMatchMode = "prefix" | "exact" | "contains" | "spaceId";

export interface DeleteSpacesQuery {
  query: string;
  matchMode?: DeleteSpacesMatchMode;
}

export interface SpaceMembershipLike {
  spaceId?: string;
  spaceName?: string;
  name?: string;
  title?: string;
  role?: string;
  ownerId?: string;
}

export interface SpaceRecordLike {
  id?: string;
  name?: string;
  title?: string;
  ownerId?: string;
  members?: string[] | Record<string, unknown>;
  contents?: Record<string, unknown>;
}

export interface SpaceDeletionPreviewItem {
  spaceId: string;
  name: string;
  ownerId: string | null;
  memberCount: number;
  contentCount: number;
}

export interface SkippedSpaceDeletionItem {
  spaceId: string;
  name: string;
  reason: "missing_space_id" | "missing_space_record" | "not_owner";
  ownerId?: string | null;
}

export interface SpaceDeletionPreview {
  deletable: SpaceDeletionPreviewItem[];
  skipped: SkippedSpaceDeletionItem[];
}

const getSpaceName = (membership: SpaceMembershipLike, record?: SpaceRecordLike) =>
  String(
    membership.spaceName ??
      membership.name ??
      membership.title ??
      record?.name ??
      record?.title ??
      membership.spaceId ??
      ""
  ).trim();

const countMembers = (members: SpaceRecordLike["members"]) => {
  if (Array.isArray(members)) return members.length;
  if (members && typeof members === "object") return Object.keys(members).length;
  return 0;
};

export function filterSpaceDeletionCandidates(
  memberships: SpaceMembershipLike[],
  query: DeleteSpacesQuery
) {
  const rawQuery = String(query.query ?? "").trim();
  if (!rawQuery) return [];
  const matchMode = query.matchMode ?? "prefix";
  const normalizedQuery = normalizeSpaceId(rawQuery).toLowerCase();
  const textQuery = rawQuery.toLowerCase();

  return memberships.filter((membership) => {
    const spaceId = normalizeSpaceId(String(membership.spaceId ?? "")).toLowerCase();
    const name = getSpaceName(membership).toLowerCase();

    if (matchMode === "spaceId") return spaceId === normalizedQuery;
    if (matchMode === "exact") return name === textQuery;
    if (matchMode === "contains") return name.includes(textQuery);
    return name.startsWith(textQuery);
  });
}

export function buildDeleteSpacesPreview(args: {
  currentUserId: string;
  candidates: SpaceMembershipLike[];
  spaceRecordsById: Record<string, SpaceRecordLike | null | undefined>;
}): SpaceDeletionPreview {
  const deletable: SpaceDeletionPreviewItem[] = [];
  const skipped: SkippedSpaceDeletionItem[] = [];

  for (const membership of args.candidates) {
    const spaceId = normalizeSpaceId(String(membership.spaceId ?? ""));
    const fallbackName = getSpaceName(membership);
    if (!spaceId) {
      skipped.push({
        spaceId: "",
        name: fallbackName,
        reason: "missing_space_id",
      });
      continue;
    }

    const record = args.spaceRecordsById[spaceId];
    const name = getSpaceName(membership, record ?? undefined) || spaceId;
    if (!record) {
      skipped.push({
        spaceId,
        name,
        reason: "missing_space_record",
      });
      continue;
    }

    const ownerId = typeof record.ownerId === "string"
      ? record.ownerId
      : typeof membership.ownerId === "string"
        ? membership.ownerId
        : null;
    if (ownerId && ownerId !== args.currentUserId) {
      skipped.push({
        spaceId,
        name,
        reason: "not_owner",
        ownerId,
      });
      continue;
    }

    deletable.push({
      spaceId,
      name,
      ownerId,
      memberCount: countMembers(record.members),
      contentCount:
        record.contents && typeof record.contents === "object"
          ? Object.keys(record.contents).length
          : 0,
    });
  }

  return { deletable, skipped };
}

export function resolveConfirmedSpaceDeletionTargets(
  preview: SpaceDeletionPreview,
  confirmedSpaceIds: string[]
) {
  const wanted = new Set(
    confirmedSpaceIds.map((spaceId) => normalizeSpaceId(spaceId)).filter(Boolean)
  );
  const targets = preview.deletable.filter((item) => wanted.has(item.spaceId));
  const found = new Set(targets.map((item) => item.spaceId));
  const missingConfirmedSpaceIds = Array.from(wanted).filter((spaceId) => !found.has(spaceId));

  return { targets, missingConfirmedSpaceIds };
}
