import { createDialogKey, dialogMessageRange } from "../../database/keys";
import { asOptionalPositiveFiniteNumber } from "../../core/optionalPositiveNumber";
import { extractCustomId } from "../../core/prefix";
import { asTrimmedString } from "../../core/trimmedString";
import { resolveAgentMemoryPolicy } from "./policy";

interface RecentDialogLike {
  dbKey?: string;
  cybots?: string[];
  summary?: string;
  title?: string;
  updatedAt?: string;
  createdAt?: string;
  spaceId?: string;
  inheritedFromDialogKey?: string;
}

interface DialogMessageLike {
  role?: string;
  authorRole?: string;
  content?: unknown;
}

const MIN_RECAP_LENGTH = 12;
const MIN_RECAP_GAP_MS = 30 * 60 * 1000;

export interface RecentRelationshipRecapResolution {
  recap: string | null;
  reason:
    | "no-db"
    | "missing-input"
    | "no-match"
    | "too-recent"
    | "low-quality"
    | "selected";
  sourceDialogKey?: string;
  sourceUpdatedAt?: string;
}

export const shouldUseRecentRelationshipRecap = (input: {
  userId?: string | null;
  agentKey?: string | null;
  agentsCount?: number;
  inheritFromDialogKey?: string | null;
  skipGreeting?: boolean;
  triggerType?: "user" | "api" | "localhost" | "scheduled_run" | "automation_run";
}): boolean => {
  if (!input.userId || !input.agentKey) return false;
  if (!resolveAgentMemoryPolicy({ agentKey: input.agentKey }).allowDynamicGreetingMemory) {
    return false;
  }
  if ((input.agentsCount ?? 0) !== 1) return false;
  if (input.inheritFromDialogKey) return false;
  if (input.skipGreeting) return false;
  if (input.triggerType && input.triggerType !== "user") return false;
  return true;
};

const CONTINUATION_CUE_PATTERNS = [
  "还没",
  "还在",
  "继续",
  "接着",
  "下一步",
  "后面",
  "之后",
  "打算",
  "准备",
  "想",
  "纠结",
  "卡住",
  "没想好",
  "不确定",
  "如何",
  "怎么",
  "?",
  "？",
];

const clip = (text: string, max = 140): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const normalizeText = (value: unknown): string => asTrimmedString(value);

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? normalizeText((part as { text?: unknown }).text)
          : ""
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
};

const toTimestamp = (record: RecentDialogLike): number => {
  return (
    asOptionalPositiveFiniteNumber(
      Date.parse(normalizeText(record.updatedAt)),
    ) ??
    asOptionalPositiveFiniteNumber(
      Date.parse(normalizeText(record.createdAt)),
    ) ??
    0
  );
};

const chooseRecapText = (record: RecentDialogLike): string => {
  const summary = normalizeText(record.summary);
  if (isMeaningfulRecapText(summary)) return clip(summary, 160);
  const title = normalizeText(record.title);
  if (isMeaningfulRecapText(title)) return clip(title, 80);
  return "";
};

const loadLastAssistantMessageText = async (
  db: any,
  dialogKey: string
): Promise<string> => {
  const dialogId = extractCustomId(dialogKey);
  if (!dialogId) return "";
  const range = dialogMessageRange(dialogId);
  let iterator = db.iterator({
    gte: range.start,
    lte: range.end,
    reverse: true,
  });

  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }

  for await (const [, value] of iterator) {
    const message = (value ?? {}) as DialogMessageLike;
    const role = normalizeText(message.role ?? message.authorRole);
    if (role !== "assistant") continue;
    const text = contentToText(message.content);
    if (isMeaningfulRecapText(text)) return clip(text, 160);
  }

  return "";
};

const isLikelyTimestampTitle = (text: string): boolean =>
  /^\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(text);

const isMeaningfulRecapText = (text: string): boolean => {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (normalized.length < MIN_RECAP_LENGTH) return false;
  if (isLikelyTimestampTitle(normalized)) return false;
  if (/^(继续|新对话|测试|test|hello|hi)$/i.test(normalized)) return false;
  return true;
};

export const resolveRecentRelationshipRecap = async (input: {
  db: any;
  userId: string;
  agentKey: string;
  currentSpaceId?: string;
  limit?: number;
}): Promise<RecentRelationshipRecapResolution> => {
  const { db, userId, agentKey, currentSpaceId, limit = 40 } = input;
  if (!db) return { recap: null, reason: "no-db" };
  if (!userId || !agentKey) return { recap: null, reason: "missing-input" };

  const range = createDialogKey.rangeOfUser(userId);
  const matches: RecentDialogLike[] = [];
  let scanned = 0;

  let iterator = db.iterator({
    gte: range.start,
    lte: range.end,
    reverse: true,
  });

  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }

  for await (const [, value] of iterator) {
    scanned += 1;
    const record = (value ?? {}) as RecentDialogLike;
    if (!Array.isArray(record.cybots) || !record.cybots.includes(agentKey)) {
      if (scanned >= limit && matches.length > 0) break;
      continue;
    }
    matches.push(record);
    if (matches.length >= limit) break;
  }

  if (matches.length === 0) return { recap: null, reason: "no-match" };

  const sorted = [...matches].sort((a, b) => {
    const aSameSpace = currentSpaceId && a.spaceId === currentSpaceId ? 1 : 0;
    const bSameSpace = currentSpaceId && b.spaceId === currentSpaceId ? 1 : 0;
    if (aSameSpace !== bSameSpace) return bSameSpace - aSameSpace;
    return toTimestamp(b) - toTimestamp(a);
  });

  let sawTooRecent = false;
  let sawLowQuality = false;
  for (const record of sorted) {
    const ts = toTimestamp(record);
    if (ts > 0 && Date.now() - ts < MIN_RECAP_GAP_MS) {
      sawTooRecent = true;
      continue;
    }
    let recap = chooseRecapText(record);
    if (!recap) {
      const dialogKey = normalizeText(record.dbKey);
      if (dialogKey) {
        recap = await loadLastAssistantMessageText(db, dialogKey);
      }
    }
    if (recap) {
      return {
        recap,
        reason: "selected",
        sourceDialogKey: normalizeText(record.dbKey) || undefined,
        sourceUpdatedAt: normalizeText(record.updatedAt) || undefined,
      };
    }
    sawLowQuality = true;
  }

  if (sawTooRecent) return { recap: null, reason: "too-recent" };
  if (sawLowQuality) return { recap: null, reason: "low-quality" };
  return { recap: null, reason: "no-match" };
};

export const mergeGreetingWithRelationshipRecap = (input: {
  greetingText?: string;
  recentRecap?: string | null;
}): string | null => {
  const greetingText = normalizeText(input.greetingText);
  const recentRecap = normalizeText(input.recentRecap);

  if (!greetingText && !recentRecap) return null;
  if (!recentRecap) return greetingText || null;
  const continuationLike = CONTINUATION_CUE_PATTERNS.some((pattern) =>
    recentRecap.includes(pattern)
  );
  if (!continuationLike) return greetingText || null;

  if (!greetingText) {
    return `我记得你上次在聊：${recentRecap}\n\n如果你还想接着那个点继续，我们可以从那里往下走；如果想换个方向也可以。`;
  }

  return `${greetingText}\n\n我记得你上次在聊：${recentRecap}\n如果你还想接着那个点继续，我们可以从那里往下走；如果想换个方向也可以。`;
};
