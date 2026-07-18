// ai/tools/searchWorkspaceTool.ts

import {
  buildMyContentItemsFromUserData,
  MY_CONTENT_USER_DATA_TYPES,
  type MyContentListItem,
} from "../../app/utils/myContentItems";
import type { SpaceContent, SpaceData, SpaceMemberWithSpaceInfo } from "../../app/types";
import { toTrimmedString } from "../../core/toTrimmedString";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import { fetchUserData } from "../../database/client/fetchUserData";
import { getUserDataItemTimestamp, mergeAndDedupUserData } from "../../database/userDataMerge";

type SearchWorkspaceArgs = { query: string };

type SearchWorkspaceResultItem = {
  title: string;
  type: string;
  contentKey: string;
  spaceId: string | null;
  spaceName?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  serverOrigin?: string;
};

type SearchWorkspaceResult = {
  rawData: { success: true; contents: SearchWorkspaceResultItem[] };
  displayData: string;
};

type SearchWorkspaceState = {
  auth?: {
    currentUser?: {
      userId?: string | null;
    } | null;
  };
  settings?: {
    currentServer?: string;
  };
  space: {
    currentSpaceId: string | null;
    currentSpace: SpaceData | null;
    memberSpaces: SpaceMemberWithSpaceInfo[] | null;
  };
};

type SearchWorkspaceThunkApi = {
  getState: () => SearchWorkspaceState;
  dispatch: (action: unknown) => unknown;
  extra: {
    db: any | null;
    tokenManager: any | null;
  };
};

const selectCurrentSpaceIdFromState = (state: SearchWorkspaceState) =>
  state.space.currentSpaceId;

const selectCurrentSpaceFromState = (state: SearchWorkspaceState) =>
  state.space.currentSpace;

const selectAllMemberSpacesFromState = (state: SearchWorkspaceState) => {
  const memberSpaces = state.space.memberSpaces ?? [];
  return [...memberSpaces].sort((a, b) => {
    const aUpdatedAt =
      a.spaceUpdatedAt ??
      (a as any).memberUpdatedAt ??
      (a as any).updatedAt ??
      (a as any).createdAt ??
      a.joinedAt ??
      0;
    const bUpdatedAt =
      b.spaceUpdatedAt ??
      (b as any).memberUpdatedAt ??
      (b as any).updatedAt ??
      (b as any).createdAt ??
      b.joinedAt ??
      0;
    return bUpdatedAt - aUpdatedAt;
  });
};

export const searchWorkspaceFunctionSchema = {
  name: "search_workspace",
  description: "在当前空间（Workspace）中搜索页面、表格等内容。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词。将匹配标题和文件名。",
      },
    },
    required: ["query"],
  },
};

export const searchAllSpacesFunctionSchema = {
  name: "search_all_spaces",
  description:
    "在当前设备已同步的全部内容中搜索当前用户的数据（等同于全部视图 Recent 的内容语义），并返回所属空间（如有）。",
  parameters: searchWorkspaceFunctionSchema.parameters,
};

const normalizeQuery = (value: unknown) =>
  asTrimmedLowercaseString(String(value || ""));

const toSearchResultItem = (
  item:
    | Pick<
        MyContentListItem,
        "title" | "type" | "contentKey" | "spaceId" | "spaceName" | "createdAt" | "updatedAt" | "serverOrigin"
      >
    | (SpaceContent & { spaceId: string; spaceName?: string })
): SearchWorkspaceResultItem => ({
  title: toTrimmedString(item.title || item.contentKey),
  type: toTrimmedString(item.type),
  contentKey: toTrimmedString(item.contentKey),
  spaceId: item.spaceId ?? null,
  ...(item.spaceName ? { spaceName: item.spaceName } : {}),
  ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
  ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
  ...("serverOrigin" in item && typeof (item as any).serverOrigin === "string" && (item as any).serverOrigin.trim().length > 0
    ? { serverOrigin: (item as any).serverOrigin }
    : {}),
});

const searchSpaceContents = (
  space: SpaceData,
  query: string,
  options?: { spaceName?: string }
): SearchWorkspaceResultItem[] => {
  const kw = normalizeQuery(query);
  const allContents = Object.values(space.contents || {});

  return allContents
    .filter((content): content is SpaceContent => {
      if (!content) return false;
      const titleMatch = (content.title ?? "").toLowerCase().includes(kw);
      const keyMatch = (content.contentKey ?? "").toLowerCase().includes(kw);
      return titleMatch || keyMatch;
    })
    .map((content) =>
      toSearchResultItem({
        ...content,
        spaceId: space.id,
        ...(options?.spaceName ? { spaceName: options.spaceName } : {}),
      })
    );
};

const matchesMyContentSearch = (
  query: string,
  item: Pick<MyContentListItem, "title" | "type" | "spaceName" | "contentKey">
) => {
  const kw = normalizeQuery(query);
  if (!kw) return false;
  return [item.title, item.type, item.spaceName, item.contentKey].some((value) =>
    normalizeQuery(value).includes(kw)
  );
};

const buildScopedDisplayData = (
  query: string,
  results: SearchWorkspaceResultItem[],
  scopeLabel: string
) => {
  if (results.length === 0) {
    return `未能在${scopeLabel}中找到匹配 "${query}" 的内容。`;
  }

  const summary = results
    .map((item) => {
      const spaceSuffix = item.spaceName ? ` [${item.spaceName}]` : "";
      return `- ${item.title} (${item.contentKey})${spaceSuffix}`;
    })
    .join("\n");

  return `在${scopeLabel}中找到 ${results.length} 个匹配项：\n${summary}`;
};

const loadLocalMyContentResults = async (
  thunkApi: SearchWorkspaceThunkApi,
  state: SearchWorkspaceState
): Promise<MyContentListItem[]> => {
  const userId = state.auth?.currentUser?.userId?.trim();
  if (!userId) {
    throw new Error("无法搜索全部内容，因为当前用户未登录。");
  }

  const db = thunkApi.extra?.db;
  if (!db) {
    throw new Error("无法搜索全部内容，因为本地数据库不可用。");
  }

  const localResults = await fetchUserData(db, MY_CONTENT_USER_DATA_TYPES, userId, {
    includeDeleted: true,
  });
  const dedupedRecords = mergeAndDedupUserData(Object.values(localResults).flat(), []);
  const sortedRecords = [...dedupedRecords].sort(
    (a, b) => getUserDataItemTimestamp(b) - getUserDataItemTimestamp(a)
  );
  const memberSpaces = selectAllMemberSpacesFromState(state);
  const spaceNameById = new Map(
    memberSpaces.map((space) => [space.spaceId, space.spaceName || space.spaceId] as const)
  );

  return buildMyContentItemsFromUserData(
    sortedRecords,
    state.settings?.currentServer || "",
    spaceNameById,
    "我的应用",
    "我的内容"
  );
};

/**
 * [Executor] 'search_workspace' 工具的执行函数。
 */
export async function searchWorkspaceFunc(
  args: SearchWorkspaceArgs,
  thunkApi: SearchWorkspaceThunkApi
): Promise<SearchWorkspaceResult> {
  const { getState } = thunkApi;
  const state = getState();
  const spaceId = selectCurrentSpaceIdFromState(state);

  if (!spaceId) {
    throw new Error("无法查询内容，因为当前空间未设定。");
  }

  const currentSpace = selectCurrentSpaceFromState(state);
  if (!currentSpace) {
    throw new Error("当前空间数据未找到。");
  }

  const results = searchSpaceContents(currentSpace, args.query, {
    spaceName: currentSpace.name,
  });

  const rawData = { success: true, contents: results } as { success: true; contents: SearchWorkspaceResultItem[] };
  const displayData = buildScopedDisplayData(args.query, results, "当前空间");

  return { rawData, displayData };
}

export async function searchAllSpacesFunc(
  args: SearchWorkspaceArgs,
  thunkApi: SearchWorkspaceThunkApi
): Promise<SearchWorkspaceResult> {
  const state = thunkApi.getState();
  const items = await loadLocalMyContentResults(thunkApi, state);
  const results = items
    .filter((item) => matchesMyContentSearch(args.query, item))
    .map((item) => toSearchResultItem(item));

  return {
    rawData: { success: true, contents: results } as { success: true; contents: SearchWorkspaceResultItem[] },
    displayData: buildScopedDisplayData(args.query, results, "已同步的全部内容"),
  };
}
