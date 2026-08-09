import { getModelAbility, type ModelAbility } from "../llm/modelAbility";

export interface SafeAgentSummary {
  id: string | null;
  /** Only present when a real public record is confirmed; omitted for private agents. */
  publicKey?: string;
  name: string;
  handle: string | null;
  introduction: string | null;
  model: string | null;
  provider: string | null;
  apiSource: string | null;
  cliProvider: string | null;
  tools: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  modelAbility: ModelAbility | null;
  isFavorite: boolean;
  favoritedAt: number | string | null;
  isPublic: boolean;
  /** True when the agent is owned by the current user (record.userId matches).
   *  Self-owned agents that use the user's own API key (apiSource "custom") or
   *  the user's own OAuth run on the user's own quota — they do not consume
   *  platform credits, so delegation should prefer them. */
  isOwned: boolean;
  updatedAt: string | number | null;
}

export type FavoritesMap =
  | Record<string, number | string | boolean>
  | Map<string, number | string | boolean>;

export interface SafeAgentSummaryOptions {
  favoritesMap?: FavoritesMap;
  isFavorite?: boolean;
  favoritedAt?: number | string | null;
  userId?: string;
  /** Caller-confirmed signal: does the public record agent-pub-<id> actually exist? */
  publicRecordExists?: boolean;
}

function parseTimestamp(val: unknown): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") return Date.parse(val) || 0;
  return 0;
}

function safeTimestamp(val: unknown): number | string | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") return val;
  return null;
}

function parseAgentRecordId(privateKey?: string, explicitId?: string): string | null {
  if (explicitId && typeof explicitId === "string" && explicitId.trim()) {
    return explicitId.trim();
  }
  if (privateKey && typeof privateKey === "string") {
    const match = privateKey.match(/^agent-[^-]+-(.+)$/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function resolveFavoriteStatus(
  record: any,
  options?: SafeAgentSummaryOptions
): { isFavorite: boolean; favoritedAt: number | string | null } {
  if (options?.isFavorite !== undefined) {
    return {
      isFavorite: !!options.isFavorite,
      favoritedAt: safeTimestamp(options.favoritedAt),
    };
  }

  if (record?.isFavorite === true) {
    return {
      isFavorite: true,
      favoritedAt: safeTimestamp(record?.favoritedAt),
    };
  }

  const favoritesMap = options?.favoritesMap;
  if (!favoritesMap) {
    return { isFavorite: false, favoritedAt: null };
  }

  const candidateKeys: string[] = [];
  if (typeof record?.dbKey === "string" && record.dbKey) candidateKeys.push(record.dbKey);
  if (typeof record?.privateKey === "string" && record.privateKey) candidateKeys.push(record.privateKey);
  if (typeof record?.publicKey === "string" && record.publicKey) candidateKeys.push(record.publicKey);
  if (typeof record?.id === "string" && record.id) {
    candidateKeys.push(record.id);
    candidateKeys.push(`agent-pub-${record.id}`);
    if (options?.userId) {
      candidateKeys.push(`agent-${options.userId}-${record.id}`);
    }
  }

  let matched = false;
  let highestFavAt: number | string | null = null;
  let highestFavTime = -1;

  for (const key of candidateKeys) {
    const val = favoritesMap instanceof Map ? favoritesMap.get(key) : favoritesMap[key];
    if (val !== undefined && val !== false && val !== null) {
      const favAt = val === true ? 1 : safeTimestamp(val);
      if (favAt === null) continue;
      matched = true;
      const time = parseTimestamp(favAt);
      if (time > highestFavTime) {
        highestFavTime = time;
        highestFavAt = favAt;
      }
    }
  }

  if (matched) {
    return {
      isFavorite: true,
      favoritedAt: highestFavAt ?? 1,
    };
  }

  return { isFavorite: false, favoritedAt: null };
}

export function toSafeAgentSummary(
  record: any,
  options?: SafeAgentSummaryOptions
): SafeAgentSummary {
  const rawId = parseAgentRecordId(
    typeof record?.privateKey === "string" ? record.privateKey : record?.dbKey,
    typeof record?.id === "string" ? record.id : undefined
  );
  const id = rawId ?? (typeof record?.id === "string" ? record.id : null);

  const publicRecordDenied = record?.publicRecordExists === false || options?.publicRecordExists === false;
  const publicRecordConfirmed = record?.publicRecordExists === true || options?.publicRecordExists === true;

  let publicKey: string | undefined;
  if (typeof record?.publicKey === "string" && record.publicKey && !publicRecordDenied) {
    // Record carries an explicit publicKey — trust it unless caller denies the public record.
    publicKey = record.publicKey;
  } else if (publicRecordConfirmed && id) {
    // Caller confirmed the public record exists — safe to derive the well-known key.
    publicKey = `agent-pub-${id}`;
  }
  // Otherwise: omit entirely so models never see a key that cannot resolve.

  const name = typeof record?.name === "string" && record.name ? record.name : "(unnamed)";
  const handle = typeof record?.handle === "string" && record.handle ? record.handle : null;
  const introduction =
    typeof record?.introduction === "string" && record.introduction
      ? record.introduction
      : typeof record?.description === "string" && record.description
        ? record.description
        : null;

  const model = typeof record?.model === "string" && record.model ? record.model : null;
  const provider =
    typeof record?.provider === "string" && record.provider
      ? record.provider
      : typeof record?.apiSource === "string" && record.apiSource
        ? record.apiSource
        : null;
  const apiSource = typeof record?.apiSource === "string" && record.apiSource ? record.apiSource : null;
  const cliProvider = typeof record?.cliProvider === "string" && record.cliProvider ? record.cliProvider : null;

  const tools = Array.isArray(record?.tools)
    ? record.tools.filter((t: unknown): t is string => typeof t === "string")
    : [];

  const inputPrice =
    typeof record?.inputPrice === "number" && Number.isFinite(record.inputPrice)
      ? record.inputPrice
      : null;
  const outputPrice =
    typeof record?.outputPrice === "number" && Number.isFinite(record.outputPrice)
      ? record.outputPrice
      : null;

  const modelAbility = model ? getModelAbility(model) ?? null : null;
  const favStatus = resolveFavoriteStatus(record, options);
  const isPublic = record?.isPublic === true || record?.isPublicFlag === true || record?.publicRecordExists === true;
  const updatedAt = safeTimestamp(record?.updatedAt ?? record?.createdAt ?? record?.created);

  // 自建判断：record.userId / ownerId 任一等于当前用户，或 dbKey 以完整前缀
  // `agent-<currentUserId>-` 开头（不解析分段——userId 本身可能含连字符，
  // 如 user-1，解析首个连字符会误判为非自建）。
  // 自建 agent 若用自己的 API（apiSource "custom"）或本地 OAuth，派发走用户自己的
  // 配额，不消耗平台 credits——选人时优先它们能省钱。
  const currentUserId = options?.userId;
  const isOwnedByRecord =
    Boolean(currentUserId) &&
    ((typeof record?.userId === "string" && record.userId === currentUserId) ||
      (typeof record?.ownerId === "string" && record.ownerId === currentUserId));
  const isOwnedByDbKey =
    Boolean(currentUserId) &&
    typeof record?.dbKey === "string" &&
    record.dbKey.startsWith(`agent-${currentUserId}-`);
  const isOwned = isOwnedByRecord || isOwnedByDbKey;

  return {
    id,
    ...(publicKey !== undefined ? { publicKey } : {}),
    name,
    handle,
    introduction,
    model,
    provider,
    apiSource,
    cliProvider,
    tools,
    inputPrice,
    outputPrice,
    modelAbility,
    isFavorite: favStatus.isFavorite,
    favoritedAt: favStatus.favoritedAt,
    isPublic,
    isOwned,
    updatedAt,
  };
}

export function sortSafeAgentSummaries<
  T extends {
    isOwned?: boolean;
    isFavorite?: boolean;
    favoritedAt?: number | string | null;
    updatedAt?: number | string | null;
    createdAt?: number | string | null;
  }
>(agents: T[]): T[] {
  return [...agents].sort((left, right) => {
    // 自建（自己的 API/OAuth，不消耗平台配额）优先 → 收藏 → 时间。
    const leftOwned = left.isOwned === true;
    const rightOwned = right.isOwned === true;

    if (leftOwned && !rightOwned) return -1;
    if (!leftOwned && rightOwned) return 1;

    const leftFav = left.isFavorite === true;
    const rightFav = right.isFavorite === true;

    if (leftFav && !rightFav) return -1;
    if (!leftFav && rightFav) return 1;

    if (leftFav && rightFav) {
      const leftFavAt = parseTimestamp(left.favoritedAt);
      const rightFavAt = parseTimestamp(right.favoritedAt);
      if (leftFavAt !== rightFavAt) return rightFavAt - leftFavAt;
    }

    const leftUpdated = parseTimestamp(left.updatedAt ?? left.createdAt);
    const rightUpdated = parseTimestamp(right.updatedAt ?? right.createdAt);
    return rightUpdated - leftUpdated;
  });
}
