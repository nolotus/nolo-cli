import type { ChatMessage } from "../../server/handlers/agentRun/types";
import { compactWhitespace } from "../../core/compactWhitespace";
import { createMemoryItem, writeMemoryItemWithIndexesToDb } from "./storeShared";
import { loadMemoryCandidatesFromDb } from "./queryShared";
import { buildAgentSubjectTarget, resolveUserOrSpaceMemoryTarget } from "./scope";
import type {
  MemoryFacet,
  MemoryItem,
  MemoryOwnerRef,
  MemoryVisibility,
} from "./types";

export interface UnderstandingMemoryCandidate {
  facet: MemoryFacet;
  content: string;
  importance: number;
  confidence: number;
  patternKey: string;
  tags: string[];
}

const UNDERSTANDING_TAG = "understanding-memory";

const normalizeClause = (value: string): string =>
  // Compact first so trailing whitespace after sentence punct still strips
  // (matches pre-seam: compact → strip end punct → trim residual spaces).
  compactWhitespace(value.replace(/[“”"]/g, ""))
    .replace(/[。！？!?；;]+$/u, "")
    .trim();

const normalizeSignalLead = (value: string): string =>
  normalizeClause(value.split(/[\n，,。！？!?；;]+/u)[0] ?? "");

const stripLead = (value: string): string =>
  value
    .replace(/^(明白|好的|对|是的|所以|其实|我记得|欢迎回来|嗯|那)\s*[，,：:\-]?\s*/u, "")
    .trim();

const contentToText = (content: ChatMessage["content"]): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part?.type === "text" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
};

const extractPreference = (text: string): string[] => {
  const matches: string[] = [];
  const normalized = stripLead(text);

  const moreValue = normalized.match(/[你我](?:更)?在意(.+)/u);
  if (moreValue?.[1]) {
    matches.push(`更在意${normalizeSignalLead(moreValue[1])}`);
  }

  const concern = normalized.match(/[你我](?:更)?关心(.+)/u);
  if (concern?.[1]) {
    matches.push(`更关心${normalizeSignalLead(concern[1])}`);
  }

  const fear = normalized.match(/[你我](?:更)?怕(.+)/u);
  if (fear?.[1]) {
    matches.push(`更怕${normalizeSignalLead(fear[1])}`);
  }

  const dontWant = normalized.match(/[你我]不想(.+)/u);
  if (dontWant?.[1]) {
    matches.push(`不想${normalizeSignalLead(dontWant[1])}`);
  }

  const dontHope = normalized.match(/[你我]不希望(.+)/u);
  if (dontHope?.[1]) {
    matches.push(`不希望${normalizeSignalLead(dontHope[1])}`);
  }

  return matches;
};

const extractStyle = (text: string): string[] => {
  const matches: string[] = [];
  const normalized = stripLead(text);

  const dislike = normalized.match(/[你我]不喜欢(.+)/u);
  if (dislike?.[1]) {
    matches.push(`不喜欢${normalizeSignalLead(dislike[1])}`);
  }

  const prefer = normalized.match(/[你我](?:更)?喜欢(.+)/u);
  if (prefer?.[1]) {
    matches.push(`更喜欢${normalizeSignalLead(prefer[1])}`);
  }

  return matches;
};

const extractGoal = (text: string): string[] => {
  const matches: string[] = [];
  const normalized = stripLead(text);
  if (/[?？]/u.test(normalized)) {
    return matches;
  }

  const wantFirst = normalized.match(/[你我](?:这次)?(?:更)?想先(?:把)?(.+)/u);
  if (wantFirst?.[1]) {
    matches.push(`想先${normalizeSignalLead(wantFirst[1])}`);
  }

  const shouldFirst = normalized.match(/[你我](?:还是)?想要先(?:把)?(.+)/u);
  if (shouldFirst?.[1]) {
    matches.push(`想先${normalizeSignalLead(shouldFirst[1])}`);
  }

  return matches;
};

const normalizeTensionTail = (tail: string): string =>
  normalizeClause(
    (
      tail.replace(/^在/u, "").replace(/^权衡/u, "").replace(/^比较/u, "")
        .split(/[。！？!?；;\n]/u)[0] ?? ""
    )
  );

const extractTension = (text: string): string[] => {
  const matches: string[] = [];
  const normalized = stripLead(text);

  const weigh = normalized.match(/[你我]在权衡(.+)/u);
  if (weigh?.[1]) {
    matches.push(`在权衡${normalizeTensionTail(weigh[1])}`);
  }

  const struggle = normalized.match(/[你我](?:现在)?(?:真正)?纠结(?:的是)?[：:，,\s]*(.+)/u);
  if (struggle?.[1] && struggle[1].includes("还是")) {
    matches.push(`在权衡${normalizeTensionTail(struggle[1])}`);
  }

  const stuck = normalized.match(/[你我]卡的点不是.+?而是(.+)/u);
  if (stuck?.[1]) {
    matches.push(`在权衡${normalizeTensionTail(stuck[1])}`);
  }

  return matches;
};

const extractUnfinished = (text: string): string[] => {
  const matches: string[] = [];
  const normalized = stripLead(text);

  const direct = normalized.match(/[你我](?:还)?(?:没|尚未)决定(.+)/u);
  if (direct?.[1]) {
    matches.push(`还没决定${normalizeClause(direct[1])}`);
  }

  const uncertain = normalized.match(/[你我](?:还)?不确定(.+)/u);
  if (uncertain?.[1]) {
    matches.push(`还不确定${normalizeClause(uncertain[1])}`);
  }

  const notReady = normalized.match(/[你我](?:还)?没想好(.+)/u);
  if (notReady?.[1]) {
    matches.push(`还没想好${normalizeClause(notReady[1])}`);
  }

  return matches;
};

const buildPatternKey = (facet: MemoryFacet, content: string): string =>
  `understanding:${facet}:${content.toLowerCase()}`;

const buildCandidate = (
  facet: MemoryFacet,
  content: string
): UnderstandingMemoryCandidate | null => {
  const normalized = normalizeClause(content);
  if (!normalized || normalized.length < 6) return null;

  const importance =
    facet === "unfinished" ? 0.91 :
    facet === "tension" ? 0.89 :
    facet === "preference" ? 0.84 :
    facet === "style" ? 0.8 :
    0.82;
  const confidence =
    facet === "unfinished" || facet === "tension" ? 0.76 : 0.72;

  return {
    facet,
    content: normalized,
    importance,
    confidence,
    patternKey: buildPatternKey(facet, normalized),
    tags: [UNDERSTANDING_TAG, `memory-facet:${facet}`],
  };
};

export const extractUnderstandingMemoryCandidates = (input: {
  userInput: string;
  trace?: ChatMessage[];
}): UnderstandingMemoryCandidate[] => {
  const texts = [
    input.userInput,
    ...(input.trace ?? [])
      .filter((message) => message.role === "assistant" || message.role === "user")
      .map((message) => contentToText(message.content)),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  const candidates: UnderstandingMemoryCandidate[] = [];
  for (const text of texts) {
    for (const content of extractPreference(text)) {
      const candidate = buildCandidate("preference", content);
      if (candidate) candidates.push(candidate);
    }
    for (const content of extractStyle(text)) {
      const candidate = buildCandidate("style", content);
      if (candidate) candidates.push(candidate);
    }
    for (const content of extractGoal(text)) {
      const candidate = buildCandidate("goal", content);
      if (candidate) candidates.push(candidate);
    }
    for (const content of extractTension(text)) {
      const candidate = buildCandidate("tension", content);
      if (candidate) candidates.push(candidate);
    }
    for (const content of extractUnfinished(text)) {
      const candidate = buildCandidate("unfinished", content);
      if (candidate) candidates.push(candidate);
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.facet}:${candidate.content.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildUnderstandingTarget = (input: {
  userId?: string | null;
  spaceId?: string | null;
  agentKey: string;
}): {
  owner: MemoryOwnerRef;
  visibility: MemoryVisibility;
  subjectType: "agent";
  subjectId: string;
} | null => {
  const target = resolveUserOrSpaceMemoryTarget(input);
  return target ? buildAgentSubjectTarget(target, input.agentKey) : null;
};

const sameUnderstanding = (item: MemoryItem, candidate: UnderstandingMemoryCandidate, agentKey: string) =>
  item.subjectType === "agent" &&
  item.subjectId === agentKey &&
  item.patternKey === candidate.patternKey;

export const captureUnderstandingMemoryFromDialog = async (input: {
  db: any;
  userId?: string | null;
  spaceId?: string | null;
  agentKey: string;
  dialogId: string;
  userInput: string;
  trace?: ChatMessage[];
}): Promise<void> => {
  const target = buildUnderstandingTarget(input);
  if (!target) return;

  const candidates = extractUnderstandingMemoryCandidates({
    userInput: input.userInput,
    trace: input.trace,
  });
  if (candidates.length === 0) return;

  const existing = await loadMemoryCandidatesFromDb(input.db, {
    owners: [target.owner],
    subjects: [{ subjectType: target.subjectType, subjectId: target.subjectId }],
    kinds: ["episodic", "semantic"],
    ownerLimit: 100,
  });

  for (const candidate of candidates) {
    const sameItems = existing.filter((item) => sameUnderstanding(item, candidate, input.agentKey));
    const existingSemantic = sameItems.find((item) => item.kind === "semantic");
    if (existingSemantic) continue;

    const existingEpisode = sameItems.find((item) => item.kind === "episodic");
    if (
      existingEpisode &&
      existingEpisode.sourceDialogId &&
      existingEpisode.sourceDialogId !== input.dialogId
    ) {
      const semantic = createMemoryItem({
        ownerType: target.owner.ownerType,
        ownerId: target.owner.ownerId,
        visibility: target.visibility,
        subjectType: target.subjectType,
        subjectId: target.subjectId,
        kind: "semantic",
        content: candidate.content,
        facet: candidate.facet,
        importance: Math.min(0.95, candidate.importance + 0.03),
        confidence: Math.min(0.86, candidate.confidence + 0.06),
        tags: [...candidate.tags, "consolidated-understanding"],
        patternKey: candidate.patternKey,
        sourceDialogId: input.dialogId,
      });
      await writeMemoryItemWithIndexesToDb(input.db, semantic);
      existing.push(semantic);
      continue;
    }

    if (existingEpisode && existingEpisode.sourceDialogId === input.dialogId) {
      continue;
    }

    const episodic = createMemoryItem({
      ownerType: target.owner.ownerType,
      ownerId: target.owner.ownerId,
      visibility: target.visibility,
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      kind: "episodic",
      content: candidate.content,
      facet: candidate.facet,
      importance: candidate.importance,
      confidence: candidate.confidence,
      tags: candidate.tags,
      patternKey: candidate.patternKey,
      sourceDialogId: input.dialogId,
    });
    await writeMemoryItemWithIndexesToDb(input.db, episodic);
    existing.push(episodic);
  }
};
