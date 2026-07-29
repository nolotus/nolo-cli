import { asOptionalPositiveFiniteNumber } from "../../core/optionalPositiveNumber";
import { normalizeServerOrigin } from "../../core/serverOrigin";

const toComparableTimestamp = (data: any): number => {
  if (!data || typeof data !== "object") return 0;

  const updatedAtMs = asOptionalPositiveFiniteNumber(
    new Date(data.updatedAt).getTime(),
  );
  if (updatedAtMs !== undefined) return updatedAtMs;

  const createdAtMs = asOptionalPositiveFiniteNumber(
    new Date(data.createdAt).getTime(),
  );
  if (createdAtMs !== undefined) return createdAtMs;

  return (
    asOptionalPositiveFiniteNumber(Number(data?.meta?.createdAt)) ?? 0
  );
};

export const partitionReadServers = ({
  allServers,
  preferredServerOrigin,
}: {
  allServers: string[];
  preferredServerOrigin?: string | null;
}): {
  preferredServer: string | null;
  fallbackServers: string[];
  orderedServersForLocalHit: string[];
} => {
  const preferredServer =
    typeof preferredServerOrigin === "string" &&
    preferredServerOrigin.trim().length > 0
      ? normalizeServerOrigin(preferredServerOrigin)
      : null;

  const fallbackServers = preferredServer
    ? allServers.filter(
        (server) => normalizeServerOrigin(server) !== preferredServer
      )
    : allServers;

  return {
    preferredServer,
    fallbackServers,
    orderedServersForLocalHit: preferredServer
      ? [preferredServer, ...fallbackServers]
      : fallbackServers,
  };
};

export const compareRemoteRecordsByComparableTime = (
  left: any,
  right: any
): number => toComparableTimestamp(left) - toComparableTimestamp(right);

export const pickBestSettledRemoteRecord = ({
  settledResults,
  isBetterCandidate,
}: {
  settledResults: PromiseSettledResult<any>[];
  isBetterCandidate: (current: any, latest: any) => boolean;
}): { data: any; index: number } | null => {
  const validResults = settledResults
    .map((result, index) => ({
      data: result.status === "fulfilled" ? result.value : null,
      index,
    }))
    .filter((item) => item.data !== null && typeof item.data === "object");

  if (validResults.length === 0) return null;

  const latest = validResults.reduce((best, current) =>
    isBetterCandidate(current.data, best.data) ? current : best
  );

  return { index: latest.index, data: latest.data };
};

export const shouldReplaceLocalWithRemoteRecord = ({
  localData,
  remoteData,
  isRemoteNewer,
}: {
  localData: any;
  remoteData: any;
  isRemoteNewer: (remoteData: any, localData: any) => boolean;
}): boolean => {
  if (!remoteData || typeof remoteData !== "object") return false;
  if (!localData || typeof localData !== "object") return true;
  return isRemoteNewer(remoteData, localData);
};

export const shouldReplicateLocalRecord = ({
  localData,
  remoteData,
  remoteTargetCount,
}: {
  localData: any;
  remoteData: any;
  remoteTargetCount: number;
}): boolean =>
  !!localData && !remoteData && remoteTargetCount > 0;

const compactUniqueServers = (
  servers: Array<string | null | undefined>
): string[] => {
  const out: string[] = [];
  for (const server of servers) {
    if (typeof server !== "string" || server.trim().length === 0) continue;
    const normalized = normalizeServerOrigin(server);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
};

export const planAuthorityReadServers = ({
  allServers,
  authorityServer,
  serverOrigin,
}: {
  allServers: string[];
  authorityServer?: string | null;
  serverOrigin?: string | null;
}): string[] =>
  compactUniqueServers([authorityServer, serverOrigin, ...allServers]);
