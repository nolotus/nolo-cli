import { selectUserId } from "../../auth/authSlice";
import { createSpaceKey } from "../../create/space/spaceKeys";
import { deleteSpace, selectAllMemberSpaces } from "../../create/space/spaceSlice";
import { read } from "../../database/dbSlice";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";

import {
  buildDeleteSpacesPreview,
  filterSpaceDeletionCandidates,
  resolveConfirmedSpaceDeletionTargets,
  type DeleteSpacesMatchMode,
  type SpaceDeletionPreview,
  type SpaceMembershipLike,
  type SpaceRecordLike,
} from "./deleteSpacesToolModel";

export interface DeleteSpacesToolArgs {
  query: string;
  matchMode?: DeleteSpacesMatchMode;
  confirmedSpaceIds?: string[];
}

interface DeleteSpacesToolDeps {
  selectCurrentUserId: (state: any) => string | undefined;
  selectMemberSpaces: (state: any) => SpaceMembershipLike[];
  readSpaceRecord: (thunkApi: any, spaceId: string) => Promise<SpaceRecordLike | null>;
  selectDeleteServers: (state: any) => string[];
  deleteServerKey: (
    thunkApi: any,
    server: string,
    dbKey: string
  ) => Promise<{ ok: boolean; status: number; detail: string }>;
  deleteOwnedSpace: (
    thunkApi: any,
    input: { spaceId: string; strategy: "delete-space-only" }
  ) => Promise<void>;
}

export const deleteSpacesFunctionSchema = {
  name: "deleteSpaces",
  description: [
    "按名称或 ID 查找并删除当前用户拥有的 Space。",
    "这是危险操作：第一次调用会返回待删除列表并等待用户确认；确认后才执行删除。",
    "默认只删除 Space 壳和成员关系，不删除其中挂载的 doc/dialog/file 内容。",
    "非 owner 的 Space 会被跳过，不会删除。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "要删除的 Space 筛选词，例如 rn_owner_verify_0504，或配合 matchMode=spaceId 传入 space id。",
      },
      matchMode: {
        type: "string",
        enum: ["prefix", "exact", "contains", "spaceId"],
        description:
          "匹配方式。prefix=名称前缀，exact=名称完全匹配，contains=名称包含，spaceId=按 Space ID 匹配。默认 prefix。",
        default: "prefix",
      },
      confirmedSpaceIds: {
        type: "array",
        items: { type: "string" },
        description:
          "可选：确认阶段要删除的 Space ID 列表。不传时，用户点击确认会删除预览列表中的全部可删除项。",
      },
    },
    required: ["query"],
  },
};

const defaultDeps: DeleteSpacesToolDeps = {
  selectCurrentUserId: selectUserId,
  selectMemberSpaces: (state) => selectAllMemberSpaces(state) as SpaceMembershipLike[],
  readSpaceRecord: async (thunkApi, spaceId) => {
    try {
      const record = await thunkApi.dispatch(
        read({ dbKey: createSpaceKey.space(spaceId), waitRemote: true } as any)
      ).unwrap();
      return record ?? null;
    } catch {
      return null;
    }
  },
  selectDeleteServers: (state) => {
    const { currentServer, remoteServers } = getRuntimeServerContext(state);
    return remoteServers.length > 0
      ? remoteServers
      : currentServer
        ? [currentServer]
        : [];
  },
  deleteServerKey: async (thunkApi, server, dbKey) => {
    const state = thunkApi.getState();
    const token = state?.auth?.currentToken;
    if (!server) {
      return { ok: false, status: 0, detail: "missing server" };
    }
    if (!token) {
      return { ok: false, status: 401, detail: "missing auth token" };
    }

    const res = await fetch(
      `${server.replace(/\/+$/, "")}/api/v1/db/delete/${encodeURIComponent(dbKey)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return {
      ok: res.ok,
      status: res.status,
      detail: await res.text().catch(() => ""),
    };
  },
  deleteOwnedSpace: async (thunkApi: any, input) => {
    await (thunkApi as any).dispatch((deleteSpace as any)(input)).unwrap();
  },
};

const readSpaceRecordsById = async (
  thunkApi: any,
  memberships: SpaceMembershipLike[],
  deps: DeleteSpacesToolDeps
) => {
  const recordsById: Record<string, SpaceRecordLike | null> = {};

  for (const membership of memberships) {
    const spaceId = String(membership.spaceId ?? "").replace(/^space-/, "");
    if (!spaceId) continue;
    recordsById[spaceId] = await deps.readSpaceRecord(thunkApi, spaceId);
  }

  return recordsById;
};

const loadDeletionContext = async (
  args: DeleteSpacesToolArgs,
  thunkApi: any,
  deps: DeleteSpacesToolDeps
): Promise<{
  currentUserId: string;
  preview: SpaceDeletionPreview;
  spaceRecordsById: Record<string, SpaceRecordLike | null>;
  deleteServers: string[];
}> => {
  const state = thunkApi.getState();
  const currentUserId = deps.selectCurrentUserId(state);
  if (!currentUserId) {
    throw new Error("deleteSpaces 需要当前登录用户。");
  }

  const memberships = deps.selectMemberSpaces(state);
  const deleteServers = deps.selectDeleteServers(state);
  const candidates = filterSpaceDeletionCandidates(memberships, {
    query: args.query,
    matchMode: args.matchMode,
  });
  const spaceRecordsById = await readSpaceRecordsById(thunkApi, candidates, deps);

  const preview = buildDeleteSpacesPreview({
    currentUserId,
    candidates,
    spaceRecordsById,
  });

  return { currentUserId, preview, spaceRecordsById, deleteServers };
};

const loadPreview = async (
  args: DeleteSpacesToolArgs,
  thunkApi: any,
  deps: DeleteSpacesToolDeps
): Promise<SpaceDeletionPreview> => {
  const { preview } = await loadDeletionContext(args, thunkApi, deps);
  return preview;
};

const spaceMemberKeysForDelete = (
  currentUserId: string,
  spaceId: string,
  record: SpaceRecordLike
) => {
  const memberIds = new Set<string>([currentUserId]);
  if (Array.isArray(record.members)) {
    for (const memberId of record.members) {
      if (typeof memberId === "string" && memberId.trim()) {
        memberIds.add(memberId.trim());
      }
    }
  } else if (record.members && typeof record.members === "object") {
    for (const memberId of Object.keys(record.members)) {
      if (memberId.trim()) memberIds.add(memberId.trim());
    }
  }
  return Array.from(memberIds).map((memberId) =>
    createSpaceKey.member(memberId, spaceId)
  );
};

const formatPreview = (preview: SpaceDeletionPreview) => {
  if (preview.deletable.length === 0 && preview.skipped.length === 0) {
    return "没有找到匹配的 Space。";
  }

  const lines = [
    `找到 ${preview.deletable.length} 个可删除 Space，${preview.skipped.length} 个跳过。`,
    "",
  ];

  if (preview.deletable.length > 0) {
    lines.push("将删除这些 Space 壳和成员关系，不删除其中 doc/dialog/file：");
    for (const item of preview.deletable) {
      lines.push(
        `- ${item.name} (${item.spaceId})，成员 ${item.memberCount}，内容 ${item.contentCount}`
      );
    }
    lines.push("");
    lines.push("需要确认后才会删除。");
  }

  if (preview.skipped.length > 0) {
    lines.push("跳过：");
    for (const item of preview.skipped) {
      const owner = item.ownerId ? `，owner=${item.ownerId}` : "";
      lines.push(`- ${item.name || item.spaceId} (${item.spaceId})：${item.reason}${owner}`);
    }
  }

  return lines.join("\n");
};

export function createDeleteSpacesToolHandlers(deps: DeleteSpacesToolDeps) {
  return {
    preview: async (args: DeleteSpacesToolArgs, thunkApi: any) => {
      const preview = await loadPreview(args, thunkApi, deps);
      return {
        rawData: preview,
        displayData: formatPreview(preview),
      };
    },
    execute: async (args: DeleteSpacesToolArgs, thunkApi: any) => {
      const { currentUserId, preview, spaceRecordsById, deleteServers } =
        await loadDeletionContext(args, thunkApi, deps);
      const confirmedIds =
        Array.isArray(args.confirmedSpaceIds) && args.confirmedSpaceIds.length > 0
          ? args.confirmedSpaceIds
          : preview.deletable.map((item) => item.spaceId);
      const { targets, missingConfirmedSpaceIds } =
        resolveConfirmedSpaceDeletionTargets(preview, confirmedIds);

      const deletedSpaceIds: string[] = [];
      const deletedKeys: string[] = [];
      const deletedRecords: Array<{ server: string; dbKey: string }> = [];
      const failures: Array<{ server?: string; dbKey: string; status: number; detail: string }> = [];
      for (const target of targets) {
        const record = spaceRecordsById[target.spaceId];
        if (!record) {
          failures.push({
            dbKey: createSpaceKey.space(target.spaceId),
            status: 404,
            detail: "space record disappeared before deletion",
          });
          continue;
        }
        if (deleteServers.length === 0) {
          failures.push({
            dbKey: createSpaceKey.space(target.spaceId),
            status: 0,
            detail: "no delete server configured",
          });
          continue;
        }
        const keys = [
          ...spaceMemberKeysForDelete(currentUserId, target.spaceId, record),
          createSpaceKey.space(target.spaceId),
        ];
        let targetFailed = false;
        for (const server of deleteServers) {
          for (const dbKey of keys) {
            const result = await deps.deleteServerKey(thunkApi, server, dbKey);
            if (!result.ok) {
              targetFailed = true;
              failures.push({ server, dbKey, status: result.status, detail: result.detail });
            } else {
              deletedKeys.push(dbKey);
              deletedRecords.push({ server, dbKey });
            }
          }
        }
        if (targetFailed) continue;

        await deps.deleteOwnedSpace(thunkApi, {
          spaceId: target.spaceId,
          strategy: "delete-space-only",
        });
        deletedSpaceIds.push(target.spaceId);
      }

      const displayData =
        deletedSpaceIds.length > 0
          ? `已删除 ${deletedSpaceIds.length} 个 Space：${deletedSpaceIds.join(", ")}。内容记录未被删除。`
          : "没有删除任何 Space。";

      return {
        rawData: {
          deletedSpaceIds,
          deletedKeys,
          deletedRecords,
          deleteServers,
          missingConfirmedSpaceIds,
          skipped: preview.skipped,
          failures,
        },
        displayData,
      };
    },
  };
}

const defaultHandlers = createDeleteSpacesToolHandlers(defaultDeps);

export const deleteSpacesPreviewFunc = defaultHandlers.preview;
export const deleteSpacesFunc = defaultHandlers.execute;
