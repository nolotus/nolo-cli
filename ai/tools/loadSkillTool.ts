import { selectRuntimeSnapshot } from "../../app/stateViews/runtime";
import { createSpaceKey } from "../../create/space/spaceKeys";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { normalizeServerOrigin } from "../../core/serverOrigin";
import { asTrimmedString } from "../../core/trimmedString";
import { parseSkillDocProtocol } from "../skills/skillDocProtocol";
import { isSkillSummaryMarker } from "../skills/skillSummaryMarker";
import { setDialogExtraReferencesAction } from "../../chat/dialog/actions/setDialogExtraReferencesAction";
import { selectById } from "../../database/dbSlice";
import type { DialogConfig, ReferenceItem } from "../../app/types";
import { getActiveDialogKey } from "../../chat/dialog/dialogRuntimeStore";
import {
  buildCodingSkillContentBySlug,
  buildCodingSkillPageKey,
  resolveCodingBuiltinSlug,
} from "../skills/codingSkills";

export interface LoadSkillToolArgs {
  name: string;
}

export const loadSkillFunctionSchema = {
  name: "loadSkill",
  description: [
    "按名称加载一个已保存的 skill 文档，返回其完整指令正文。",
    "name 使用 skill 保存时写入 skill-config 的 name（也接受 skillId）。",
    "找不到对应 skill 时返回当前可用的 skill 名称列表（不报错）。",
    "系统内置写代码技能：对话转向写代码时用 loadSkill(\"coding\") 载入写代码能力与代码审查纪律（含 review 角色切割）。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "要加载的 skill 名称。",
      },
    },
    required: ["name"],
  },
} as const;

const getRuntime = (thunkApi: any) => {
  const state = thunkApi?.getState?.();
  return state ? selectRuntimeSnapshot(state) : null;
};

const authHeaders = (token?: string) =>
  token ? { Authorization: `Bearer ${token}` } : {};

async function readRemoteRecord(args: {
  serverBase?: string;
  token?: string;
  dbKey: string;
}): Promise<Record<string, any> | null> {
  const serverBase = normalizeServerOrigin(args.serverBase);
  if (!serverBase || !args.token) return null;
  const response = await fetch(
    `${serverBase}/api/v1/db/read/${encodeURIComponent(args.dbKey)}?includeDeleted=true`,
    { headers: authHeaders(args.token) } as RequestInit
  );
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload?.data ?? payload;
}

type SkillCandidate = {
  dbKey: string;
  name: string;
  skillId?: string;
};

/**
 * Match a requested name against a skill candidate by name or skillId. Shared
 * by the client-side `loadSkillFunc` and the server-side agentRun executor
 * (packages/server/handlers/agentRun/noloWorkspaceServerTools.ts) so both
 * surfaces resolve by the same rule.
 */
export function matchSkillCandidate(
  candidates: SkillCandidate[],
  requestedName: string,
): SkillCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.name === requestedName ||
      candidate.skillId === requestedName,
  );
}

/**
 * Collect skill candidates (entryKey + name + skillId) from a single space
 * record's `contents` map, mirroring the rule in `listSkillCandidates`.
 * Exported so the server-side agentRun executor can reuse the same collection
 * logic against a `deps.readDbRecord(spaceKey)` result instead of a fetch.
 */
export function collectSkillCandidatesFromSpace(
  space: Record<string, any> | null | undefined,
): SkillCandidate[] {
  if (!space?.contents || typeof space.contents !== "object") return [];
  const candidates: SkillCandidate[] = [];
  for (const [entryKey, value] of Object.entries(space.contents)) {
    if (!isRecord(value)) continue;
    const skillSummary = (value as Record<string, any>).skillSummary;
    if (!isSkillSummaryMarker(skillSummary)) continue;
    const name = asTrimmedString(skillSummary.name);
    if (!name) continue;
    candidates.push({
      dbKey: entryKey,
      name,
      skillId: asOptionalTrimmedString(skillSummary.skillId) ?? undefined,
    });
  }
  return candidates;
}

/**
 * Extract the skill body from a page record, stripping the skill-config
 * protocol block. Shared by client and server loadSkill surfaces.
 */
export function extractSkillBody(page: Record<string, any> | null | undefined): string {
  return parseSkillDocProtocol(page?.content ?? "").content;
}

/**
 * Format the not-found contract text for loadSkill. The web renderer keys off
 * the `Skill "<name>" not found in this workspace's skill directories` prefix
 * (see ToolMessageContent.tsx loadSkill renderer), so this exact prefix is a
 * contract — do not change the wording.
 */
export function formatLoadSkillNotFoundText(
  requestedName: string,
  availableNames: string[],
): string {
  const availableText = availableNames.length
    ? `Available skills: ${availableNames.join(", ")}`
    : "No skills were discovered in this workspace.";
  return `Skill "${requestedName}" not found. Available skills: ${availableText}`;
}

/**
 * 平台侧 skill 真值来源：用户 nolo 数据中的 skill 文档 page 记录，
 * 其按名索引冗余在 space 记录的 contents[dbKey].skillSummary
 * （由 buildSkillSummaryMarker 写入）。这里先从所有 space 收集
 * skillSummary 索引，再按 name/skillId 匹配。
 */
async function listSkillCandidates(thunkApi: any): Promise<SkillCandidate[]> {
  const runtime = getRuntime(thunkApi);
  const serverBase = runtime?.currentServer;
  const token = runtime?.currentToken;
  const userId = runtime?.currentUserId;
  if (!serverBase || !token || !userId) return [];

  const membershipsResponse = await fetch(
    `${normalizeServerOrigin(serverBase)}/rpc/getUserSpaceMemberships`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ userId }),
    } as RequestInit
  ).catch(() => null);
  if (!membershipsResponse?.ok) return [];

  const memberships = await membershipsResponse.json().catch(() => []);
  if (!Array.isArray(memberships)) return [];

  const candidates: SkillCandidate[] = [];
  for (const membership of memberships) {
    const spaceId = asTrimmedString(membership?.spaceId);
    if (!spaceId) continue;
    const space = await readRemoteRecord({
      serverBase,
      token,
      dbKey: createSpaceKey.space(spaceId),
    });
    if (!space) continue;
    candidates.push(...collectSkillCandidatesFromSpace(space));
  }
  return candidates;
}

export async function loadSkillFunc(
  args: LoadSkillToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const requestedName = asTrimmedString(args?.name);
  if (!requestedName) throw new Error("loadSkill 需要提供 name。");

  const candidates = await listSkillCandidates(thunkApi);
  let matched = matchSkillCandidate(candidates, requestedName);

  // 系统内置 coding skill 回退：space 索引找不到时，检查是否是系统内置
  // coding skill（coding / coding-review / coding-review-*）。系统内置 skill
  // 内容由 codingSkills.ts 提供，不依赖 space 索引或 DB seed——直接返回内置
  // 内容，保证 agent 在对话中始终能 loadSkill("coding") 自主载入写代码能力。
  const builtinSlug = !matched
    ? resolveCodingBuiltinSlug(requestedName)
    : null;
  if (builtinSlug) {
    const runtime = getRuntime(thunkApi);
    const userId = runtime?.currentUserId;
    const body = buildCodingSkillContentBySlug(builtinSlug);
    const dbKey = userId
      ? buildCodingSkillPageKey(userId, builtinSlug)
      : builtinSlug;
    // 关键：extraReferences 指向的 dbKey 必须在 DB 中真实存在，否则后续 turn 的
    // resolveReferenceAssets 用 read(dbKey) 读到 null，工具面不会扩展。因此这里
    // 先 ensure coding skill 页落库（best-effort），再写 extraReferences。
    if (userId) {
      try {
        const { ensureCodingSkills } = await import("../skills/codingSkills");
        await ensureCodingSkills(userId)(thunkApi?.dispatch ?? (() => Promise.resolve()));
      } catch {
        // best-effort: 落库失败不阻断返回，但工具面扩展依赖 DB 存在。
      }
    }
    // 载入后把 reference 追加到 dialog.extraReferences，让后续 turn 工具面扩展。
    await persistLoadedSkillReference(thunkApi, dbKey, requestedName);
    return {
      rawData: {
        success: true,
        name: requestedName,
        dbKey,
        body,
      },
      displayData: `Skill "${requestedName}" loaded inline. Follow its instructions.\n\n${body}`,
    };
  }

  if (!matched) {
    const availableNames = Array.from(
      new Set(candidates.map((candidate) => candidate.name))
    );
    const availableText = availableNames.length
      ? availableNames.join(", ")
      : "(none)";
    return {
      rawData: {
        success: false,
        name: requestedName,
        availableSkills: availableNames,
      },
      displayData: `Skill "${requestedName}" not found. Available skills: ${availableText}`,
    };
  }

  const runtime = getRuntime(thunkApi);
  const page = await readRemoteRecord({
    serverBase: runtime?.currentServer,
    token: runtime?.currentToken,
    dbKey: matched.dbKey,
  });
  const body = extractSkillBody(page);

  // 载入 skill 后，把该 skill 的 reference 追加到当前 dialog 的 extraReferences，
  // 让后续 turn 的工具面自动扩展出该 skill 声明的工具（跨 turn 生效）。
  // 这是「agent 在对话中自主载入 coding 能力」的核心机制：普通用户对话不
  // loadSkill coding → 不挂 code 工具；一旦载入 → 本对话后续 turn 有 code 工具。
  await persistLoadedSkillReference(thunkApi, matched.dbKey, requestedName);

  return {
    rawData: {
      success: true,
      name: requestedName,
      dbKey: matched.dbKey,
      body,
    },
    displayData: `Skill "${requestedName}" loaded inline. Follow its instructions.\n\n${body}`,
  };
}

/**
 * Append the loaded skill's reference to the current dialog's extraReferences
 * (idempotent by dbKey). Best-effort: if there is no active dialog or the
 * write fails, the skill body still returns — the tool surface just won't
 * expand until the skill is mounted another way.
 */
async function persistLoadedSkillReference(
  thunkApi: any,
  dbKey: string,
  name: string,
): Promise<void> {
  try {
    const state = thunkApi?.getState?.();
    const currentDialogKey = getActiveDialogKey();
    if (!state || !currentDialogKey) return;

    const dialogConfig = selectById(
      state,
      currentDialogKey,
    ) as DialogConfig | undefined;
    const existing = dialogConfig?.extraReferences ?? [];
    const alreadyMounted = existing.some((ref) => ref.dbKey === dbKey);
    if (alreadyMounted) return;

    const newRef: ReferenceItem = {
      dbKey,
      title: name,
      type: "instruction",
    };
    await setDialogExtraReferencesAction([...existing, newRef], thunkApi);
  } catch {
    // best-effort: skill body already returned; tool expansion is a bonus.
  }
}
