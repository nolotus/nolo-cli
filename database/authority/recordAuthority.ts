import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { parseOwnerUserIdFromDbKey } from "./ownerKey";
import {
  normalizeAuthorityServerOrigin,
  resolveUserAuthorityServer,
  type UserAuthorityRegistry,
} from "./userAuthorityRegistry";

export type RecordAuthorityInput = {
  dbKey: string;
  record?: Record<string, unknown> | null;
  currentUserId?: string | null;
  currentServer?: string | null;
  userAuthorityRegistry?: UserAuthorityRegistry | null;
};

export type RecordAuthorityResolution = {
  ownerUserId: string | null;
  authorityServer: string | null;
  serverOrigin: string | null;
};

const normalizeUserId = (value: unknown): string | null =>
  asOptionalTrimmedString(value) ?? null;

const getRegistryOwnerCandidates = (
  registry: UserAuthorityRegistry | null | undefined
): string[] => (isRecord(registry) ? Object.keys(registry) : []);

export const resolveRecordAuthority = ({
  dbKey,
  record,
  currentUserId,
  currentServer,
  userAuthorityRegistry,
}: RecordAuthorityInput): RecordAuthorityResolution => {
  const ownerUserId =
    parseOwnerUserIdFromDbKey(dbKey, {
      candidateOwnerUserIds: [
        normalizeUserId(record?.userId),
        normalizeUserId(currentUserId),
        ...getRegistryOwnerCandidates(userAuthorityRegistry),
      ],
    }) ?? normalizeUserId(record?.userId);
  const serverOrigin = normalizeAuthorityServerOrigin(record?.serverOrigin);
  const explicitAuthority = normalizeAuthorityServerOrigin(record?.authorityServer);
  const registryAuthority = resolveUserAuthorityServer({
    ownerUserId,
    registry: userAuthorityRegistry,
  });
  const currentUserAuthority =
    ownerUserId && ownerUserId === normalizeUserId(currentUserId)
      ? normalizeAuthorityServerOrigin(currentServer)
      : null;

  return {
    ownerUserId,
    authorityServer:
      explicitAuthority ?? registryAuthority ?? currentUserAuthority ?? serverOrigin,
    serverOrigin,
  };
};
