import { selectRuntimeSnapshot } from "../../app/stateViews/runtime";
import { createSpaceKey } from "../../create/space/spaceKeys";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { normalizeServerOrigin } from "../../core/serverOrigin";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
import { asTrimmedString } from "../../core/trimmedString";
import { parseSkillDocProtocol } from "../skills/skillDocProtocol";
import { isSkillSummaryMarker } from "../skills/skillSummaryMarker";
import { setDialogExtraReferencesAction } from "../../chat/dialog/actions/setDialogExtraReferencesAction";
import { selectById } from "../../database/dbSlice";
import type { DialogConfig, ReferenceItem } from "../../app/types";
import { getActiveDialogKey } from "../../chat/dialog/dialogRuntimeStore";
import {
  listBuiltinSkills,
  resolveBuiltinSkillByName,
} from "../skills/builtinSkillRegistry";
import {
  isAgentSkillDisabled,
  type AgentSkillConfigSource,
} from "./agentSkillConfig";

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
    "系统内置专职技能：feedback（反馈收集）/ agent-creator（创建 Agent）/ app-builder（应用构建），同样可直接 loadSkill 载入。",
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

export type SkillCandidate = {
  dbKey: string;
  name: string;
  skillId?: string;
};

export type WebSkillResolution =
  | { kind: "space"; candidate: SkillCandidate }
  | { kind: "builtin"; entry: NonNullable<ReturnType<typeof resolveBuiltinSkillByName>> }
  | null;

/** Resolve a Web-visible skill using the same ordered registry for discovery and loading. */
export function resolveWebSkill(
  candidates: SkillCandidate[],
  requestedName: string,
): WebSkillResolution {
  const candidate = matchSkillCandidate(candidates, requestedName);
  if (candidate) return { kind: "space", candidate };
  const entry = resolveBuiltinSkillByName(requestedName);
  return entry ? { kind: "builtin", entry } : null;
}

export function listWebSkillNames(candidates: SkillCandidate[]): string[] {
  return Array.from(
    new Set([
      ...candidates.map((candidate) => candidate.name),
      ...listBuiltinSkills().flatMap((skill) => [skill.slug, skill.title]),
    ]),
  );
}

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

/**
 * 解析当前 dialog 绑定的 agentKey（loadSkill 三态网关用）：fixed 对话取
 * cybots[0]（主 agent）。auto 对话 / 无 active dialog 返回 null——此时网关
 * 放行，宁可漏检也不可误拒存量 agent。
 */
const resolveCurrentAgentKeyForSkillGate = (thunkApi: any): string | null => {
  try {
    const state = thunkApi?.getState?.();
    if (!state) return null;
    const currentDialogKey = getActiveDialogKey();
    if (!currentDialogKey) return null;
    const dialogConfig = selectById(
      state,
      currentDialogKey,
    ) as DialogConfig | undefined;
    return asTrimmedNonEmptyStringArray(dialogConfig?.cybots)[0] ?? null;
  } catch {
    return null;
  }
};

/**
 * 读取当前 agent 的 skill 配置源（{ skills, enabledPacks }），供
 * isAgentSkillDisabled 判断。读不到（无 dialog agent / 无本地 db / 记录缺失）
 * 一律返回 null——网关按「缺席」放行。
 */
const readCurrentAgentSkillSource = async (
  thunkApi: any,
): Promise<AgentSkillConfigSource | null> => {
  const agentKey = resolveCurrentAgentKeyForSkillGate(thunkApi);
  if (!agentKey) return null;
  const db = (thunkApi?.extra as any)?.db;
  if (!db) return null;
  try {
    const agent = await db.get(agentKey);
    if (!agent || typeof agent !== "object") return null;
    return agent as AgentSkillConfigSource;
  } catch {
    return null;
  }
};

export async function loadSkillFunc(
  args: LoadSkillToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const requestedName = asTrimmedString(args?.name);
  if (!requestedName) throw new Error("loadSkill 需要提供 name。");

  const candidates = await listSkillCandidates(thunkApi);
  const resolution = resolveWebSkill(candidates, requestedName);
  const matched = resolution?.kind === "space" ? resolution.candidate : undefined;

  // 系统内置 skill 回退：space 索引找不到时查内置注册表（coding /
  // coding-review-* / feedback / agent-creator / app-builder / code-planning …）。
  //
  // 内容全部来自代码，**不落库**：引用解析（referenceUtils）已经会先问注册表
  // 再查 DB，所以 extraReferences 指向 slug 就够了，下一轮照样能解析出工具面。
  // 这替换掉了原先按 skill 逐个复制的「先 ensure 落库、再写 reference」绕行——
  // 那套是 best-effort，落库失败时工具面会静默不扩展，DB 副本还会相对代码变旧。
  const builtinEntry = resolution?.kind === "builtin" ? resolution.entry : null;

  // 三态网关（quickchat-skill-cross-use 收尾）：解析出 slug 后检查当前 agent
  // 是否**显式禁用**了该能力（agent.skills[slug] === "disabled"）。命中则拒绝
  // 加载，正文不返回。缺席 / required / recommended 一律放行——存量 agent 大多
  // 没配过 skills，拿不到 agent 配置也放行（不能误拒）。
  const resolvedSlug = builtinEntry?.slug ?? matched?.skillId ?? null;
  if (resolvedSlug) {
    const agentSkillSource = await readCurrentAgentSkillSource(thunkApi);
    if (
      agentSkillSource &&
      isAgentSkillDisabled(agentSkillSource, resolvedSlug)
    ) {
      return {
        rawData: {
          success: false,
          name: requestedName,
          slug: resolvedSlug,
          disabled: true,
        },
        displayData: `Skill "${requestedName}" 已被禁用：该能力在此 agent 上不可用，无法加载。`,
      };
    }
  }

  if (builtinEntry) {
    const body = builtinEntry.content;
    // 用 slug 作为引用键：稳定、与 userId 无关，且注册表认得。
    const dbKey = builtinEntry.slug;
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
    const availableNames = listWebSkillNames(candidates);
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
