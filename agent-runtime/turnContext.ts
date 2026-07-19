/**
 * Host-neutral turn context assembly.
 *
 * Builds the space / workspace context layers for an agent turn from
 * persisted records only — no Redux, no UI state. Every execution surface
 * (desktop host runtime, web/RN renderer, server agentRun, CLI) supplies a
 * `TurnContextSource` adapter over its own record access and gets identical
 * layer semantics. The dialog record's `spaceId` is the single source of
 * truth for space membership.
 *
 * Resolution failures must stay visible: when a declared space cannot be
 * read, the layer says so explicitly instead of silently omitting the
 * block, so the model never tells the user "this dialog is in no space"
 * just because a read failed.
 */

import { wrapHistoricalSummaryWithReplayGuard } from "./staleReplayGuard";
import { MEMORY_USE_GUIDANCE } from "./memoryUseGuidance";

export interface TurnContextSource {
  /** Read a persisted record by dbKey (e.g. `space-{id}`). Null when absent. */
  readRecord(dbKey: string): Promise<Record<string, unknown> | null>;
}

export interface TurnContextLayer {
  id:
    | "space-context"
    | "workspace-context"
    | "user-global-prompt"
    | "memory-overlay"
    | "dialog-summary"
    | "proactive-summary";
  owner: "runtime";
  cacheScope: "turn";
  content: string;
}

const DEFAULT_RECENT_CONTENT_LIMIT = 10;

const asTrimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asFiniteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const spaceRecordKey = (spaceId: string): string =>
  spaceId.startsWith("space-") ? spaceId : `space-${spaceId}`;

const makeLayer = (
  id: TurnContextLayer["id"],
  content: string,
): TurnContextLayer => ({ id, owner: "runtime", cacheScope: "turn", content });

interface SpaceCategoryLike {
  name?: unknown;
  order?: unknown;
}

interface SpaceContentLike {
  title?: unknown;
  type?: unknown;
  contentKey?: unknown;
  categoryId?: unknown;
  updatedAt?: unknown;
}

/** Renders the same structural summary the web renderer historically built. */
export const renderSpaceStructure = (
  spaceRecord: Record<string, unknown>,
  recentLimit: number,
): string => {
  const categories = (spaceRecord.categories ?? {}) as Record<
    string,
    SpaceCategoryLike | null
  >;
  const validCategories = Object.entries(categories)
    .filter((entry): entry is [string, SpaceCategoryLike] => entry[1] !== null)
    .sort(
      (a, b) => asFiniteNumber(a[1].order) - asFiniteNumber(b[1].order),
    );

  const categoryNameById = new Map<string, string>();
  let struct = "Directory Structure (Categories):\n";
  if (validCategories.length === 0) struct += "(No categories defined)\n";
  validCategories.forEach(([id, category]) => {
    const name = asTrimmed(category.name) || id;
    categoryNameById.set(id, name);
    struct += `- ${name} (ID: ${id})\n`;
  });

  const contents = (spaceRecord.contents ?? {}) as Record<
    string,
    SpaceContentLike | null
  >;
  const recentContents =
    recentLimit > 0
      ? Object.values(contents)
          .filter((content): content is SpaceContentLike => content !== null)
          .sort(
            (a, b) => asFiniteNumber(b.updatedAt) - asFiniteNumber(a.updatedAt),
          )
          .slice(0, recentLimit)
      : [];

  if (recentContents.length > 0) {
    struct += `\nRecent Contents (Top ${recentLimit}):\n`;
    recentContents.forEach((content) => {
      const categoryId = asTrimmed(content.categoryId);
      const categoryName = categoryId
        ? categoryNameById.get(categoryId) || "Unknown"
        : "Uncategorized";
      struct += `- [${asTrimmed(content.type) || "content"}] ${asTrimmed(content.title)} (Category: ${categoryName}, dbKey: ${asTrimmed(content.contentKey)})\n`;
    });
  }

  return struct;
};

export interface BuildSpaceContextLayerArgs {
  source: TurnContextSource;
  /** Dialog record's spaceId — the single source of truth. */
  spaceId: string | null | undefined;
  /** Max recent contents listed; callers tune per token budget. */
  recentContentLimit?: number;
}

/**
 * Space context layer from the persisted space record.
 * - no spaceId → null (dialog genuinely belongs to no space)
 * - read failure / missing record → explicit failure layer, never silence
 */
export const buildSpaceContextLayer = async (
  args: BuildSpaceContextLayerArgs,
): Promise<TurnContextLayer | null> => {
  const spaceId = asTrimmed(args.spaceId);
  if (!spaceId) return null;

  const recentLimit = args.recentContentLimit ?? DEFAULT_RECENT_CONTENT_LIMIT;

  let spaceRecord: Record<string, unknown> | null = null;
  let readError: string | null = null;
  try {
    spaceRecord = await args.source.readRecord(spaceRecordKey(spaceId));
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }

  if (!spaceRecord) {
    return makeLayer(
      "space-context",
      [
        "--- 当前空间（Space）---",
        `本对话记录声明属于 Space ${spaceId}，但当前无法读取该 Space 的数据${readError ? `（${readError}）` : "（记录不存在或不可达）"}。`,
        "如被问及，请如实说明「对话属于该 Space 但暂时读不到空间详情」，不要声称对话不属于任何空间。",
      ].join("\n"),
    );
  }

  const name = asTrimmed(spaceRecord.name);
  const description = asTrimmed(spaceRecord.description);
  const structure = renderSpaceStructure(spaceRecord, recentLimit);

  return makeLayer(
    "space-context",
    [
      "--- 当前空间（Space）---",
      "本对话属于以下 Space：",
      `Space Title: ${name || spaceId}`,
      `Space ID: ${spaceId}`,
      `Description: ${description || "N/A"}`,
      "",
      structure.trimEnd(),
    ].join("\n"),
  );
};

export interface BuildWorkspaceContextLayerArgs {
  spaceId?: string | null;
  /** The space record's boundFolder, when declared. */
  boundFolder?: string | null;
  /** The effective working directory the runtime actually resolved. */
  cwd?: string | null;
  /** Human-readable reason when boundFolder resolution failed. */
  resolutionError?: string | null;
}

/**
 * Workspace context layer: tells the model which local folder this dialog is
 * bound to (or that binding resolution failed). Null when there is neither a
 * binding nor a failure to report.
 */
export const buildWorkspaceContextLayer = (
  args: BuildWorkspaceContextLayerArgs,
): TurnContextLayer | null => {
  const spaceId = asTrimmed(args.spaceId);
  const boundFolder = asTrimmed(args.boundFolder);
  const cwd = asTrimmed(args.cwd);
  const resolutionError = asTrimmed(args.resolutionError);

  if (resolutionError) {
    return makeLayer(
      "workspace-context",
      [
        "--- 工作区（Workspace）---",
        `本对话${spaceId ? `所属 Space ${spaceId} ` : ""}声明绑定了本地工作区，但解析失败：${resolutionError}。`,
        "如被问及工作区/绑定文件夹，请如实说明绑定存在但当前不可用。",
      ].join("\n"),
    );
  }

  if (!boundFolder && !cwd) return null;

  const lines = ["--- 工作区（Workspace）---"];
  if (boundFolder) {
    lines.push(
      `本对话${spaceId ? `通过 Space ${spaceId} ` : ""}绑定了本地工作区目录：${boundFolder}`,
    );
    if (cwd && cwd !== boundFolder) {
      lines.push(`本轮实际工作目录（cwd）：${cwd}`);
    } else {
      lines.push("文件/Shell 类工具默认以该目录为根。");
    }
  } else {
    lines.push(`本轮工作目录（cwd）：${cwd}`);
  }
  return makeLayer("workspace-context", lines.join("\n"));
};

export interface BuildLinkedSpacesSectionArgs {
  source: TurnContextSource;
  /** Agent-declared linked space ids (bare or `space-` prefixed). */
  linkedSpaceIds: Array<string | null | undefined> | null | undefined;
}

/**
 * Linked-spaces summary section. Reads each linked space record via the shared
 * source and renders the historical "粗略上下文" list, with an explicit
 * `[无法访问]` marker per space that could not be read (never silently drops).
 * Returns the section text (without leading newlines) or null when there are
 * no linked spaces. Callers append it to the space-context string.
 */
export const buildLinkedSpacesSection = async (
  args: BuildLinkedSpacesSectionArgs,
): Promise<string | null> => {
  const ids = (args.linkedSpaceIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.trim() !== "",
  );
  if (ids.length === 0) return null;

  const lines: string[] = [];
  for (const rawId of ids) {
    const spaceId = asTrimmed(rawId);
    let spaceData: Record<string, unknown> | null = null;
    try {
      spaceData = await args.source.readRecord(spaceRecordKey(spaceId));
    } catch {
      spaceData = null;
    }
    if (spaceData) {
      const name = asTrimmed(spaceData.name) || spaceId;
      const desc = asTrimmed(spaceData.description);
      lines.push(`- ${name} (ID: ${spaceId})${desc ? `: ${desc}` : ""}`);
    } else {
      lines.push(`- [无法访问] ${spaceId}`);
    }
  }

  if (lines.length === 0) return null;

  return [
    "--- 关联空间 (Linked Spaces) ---",
    "以下是 Agent 可访问的其他工作空间（粗略上下文）：",
    lines.join("\n"),
    "",
    "提示：如需查询这些空间的详细内容，可使用 read 工具配合对应的 dbKey。",
  ].join("\n");
};

/** Renders layers into the plain-text blocks appended to a system prompt. */
export const renderTurnContextBlocks = (
  layers: Array<TurnContextLayer | null | undefined>,
): string[] =>
  layers
    .filter((layer): layer is TurnContextLayer => Boolean(layer?.content?.trim()))
    .map((layer) => layer.content.trim());

// ============================================================================
// T12 — Dialog summary layer
// ============================================================================

export interface BuildDialogSummaryLayerArgs {
  /** Dialog record's compressed historical summary (`summary` field). */
  summary?: string | null;
  /** Dialog record's proactive/recent-work summary (`proactiveSummary` field). */
  proactiveSummary?: string | null;
}

/**
 * Dialog summary layer: historical conversation summary + proactive work
 * summary, each wrapped in the stale-replay guard so the model cannot replay
 * old task descriptions / skill calls as live instructions.
 *
 * Semantically equivalent to the renderer's `dialogSummary` / `proactiveSummary`
 * sections in `buildSystemPrompt.ts`. Returns one combined layer (with both
 * sections when present) or null when neither summary has content.
 *
 * Failure visibility: a missing/empty summary is a legitimate "no summary
 * yet" state (returns null), not a fault — unlike a space read failure, an
 * absent summary carries no false claim to correct.
 */
export const buildDialogSummaryLayer = (
  args: BuildDialogSummaryLayerArgs,
): TurnContextLayer | null => {
  const historical = wrapHistoricalSummaryWithReplayGuard(
    asTrimmed(args.summary),
  );
  const proactive = wrapHistoricalSummaryWithReplayGuard(
    asTrimmed(args.proactiveSummary),
  );
  if (!historical && !proactive) return null;

  const sections: string[] = [];
  if (historical) {
    sections.push(`--- 历史对话摘要 ---\n${historical}`);
  }
  if (proactive) {
    sections.push(`--- 阶段工作摘要 ---\n${proactive}`);
  }
  return makeLayer("dialog-summary", sections.join("\n\n"));
};

// ============================================================================
// T13 — User global prompt layer
// ============================================================================

export interface BuildUserGlobalPromptLayerArgs {
  source: TurnContextSource;
  /**
   * userId resolved from the dialog record (or its key). MUST NOT come from
   * host env — the env user can diverge from the logged-in user whose
   * preferences should apply (see D1 in the plan).
   */
  userId: string | null | undefined;
  /** Settings record key builder; defaults to `${userId}-settings`. */
  settingsKey?: (userId: string) => string;
}

/**
 * User global prompt layer: reads the user's settings record and extracts
 * `globalPrompt`. Null when there is no userId (no dialog record → do not
 * guess the user) or when the settings record / globalPrompt is absent.
 *
 * A missing settings record is a legitimate "user set no global prompt"
 * state (returns null), not a fault. A real read failure is surfaced as an
 * explicit failure layer so a database outage is not disguised as "user has
 * no preferences".
 */
export const buildUserGlobalPromptLayer = async (
  args: BuildUserGlobalPromptLayerArgs,
): Promise<TurnContextLayer | null> => {
  const userId = asTrimmed(args.userId);
  if (!userId) return null;

  const key = args.settingsKey
    ? args.settingsKey(userId)
    : `${userId}-settings`;

  let settingsRecord: Record<string, unknown> | null = null;
  let readError: string | null = null;
  try {
    settingsRecord = await args.source.readRecord(key);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }

  if (readError) {
    return makeLayer(
      "user-global-prompt",
      [
        "--- 用户全局偏好 ---",
        `读取用户 ${userId} 的偏好设置失败（${readError}）。`,
        "如被问及用户偏好，请如实说明当前无法读取用户设置，不要编造偏好。",
      ].join("\n"),
    );
  }

  const globalPrompt = asTrimmed(settingsRecord?.globalPrompt);
  if (!globalPrompt) return null;

  return makeLayer(
    "user-global-prompt",
    `-- - 用户全局偏好-- -\n${globalPrompt}`,
  );
};

// ============================================================================
// T14 — Memory overlay layer
// ============================================================================

export interface BuildMemoryOverlayLayerArgs {
  /**
   * The already-fetched memory overlay promptBlock text. The host performs the
   * network call to `{server}/api/memory/query` (which requires auth + server
   * config that `agent-runtime` must not depend on) and hands the resulting
   * text here — mirroring how the workspace layer receives an already-resolved
   * boundFolder. `TurnContextSource` stays a "read records" interface and is
   * NOT extended for network calls.
   */
  promptBlock?: string | null;
}

/**
 * Memory overlay layer: appends the memory-use guidance so the model knows
 * memory is a personalization enhancement layer subordinated to the current
 * input / dialog / system rules / agent prompt / user global prompt. Without
 * this guidance, stale memory can be treated as higher truth than fresh user
 * instructions.
 *
 * Null when there is no memory promptBlock (no memory matched, or the host
 * omitted the layer after a network failure — see host wiring for the
 * failure-visibility policy).
 */
export const buildMemoryOverlayLayer = (
  args: BuildMemoryOverlayLayerArgs,
): TurnContextLayer | null => {
  const promptBlock = asTrimmed(args.promptBlock);
  if (!promptBlock) return null;
  return makeLayer(
    "memory-overlay",
    `${promptBlock}\n\n${MEMORY_USE_GUIDANCE}`,
  );
};
