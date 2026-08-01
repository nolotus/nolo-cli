import { selectRuntimeSnapshot } from "../../app/stateViews/runtime";
import { createSpaceKey } from "../../create/space/spaceKeys";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { normalizeServerOrigin } from "../../core/serverOrigin";
import { asTrimmedString } from "../../core/trimmedString";
import { parseSkillDocProtocol } from "../skills/skillDocProtocol";
import { isSkillSummaryMarker } from "../skills/skillSummaryMarker";

export interface LoadSkillToolArgs {
  name: string;
}

export const loadSkillFunctionSchema = {
  name: "loadSkill",
  description: [
    "按名称加载一个已保存的 skill 文档，返回其完整指令正文。",
    "name 使用 skill 保存时写入 skill-config 的 name（也接受 skillId）。",
    "找不到对应 skill 时返回当前可用的 skill 名称列表（不报错）。",
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
  const matched = matchSkillCandidate(candidates, requestedName);

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
