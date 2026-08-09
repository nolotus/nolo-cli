import { format } from "date-fns";

import type { Agent, DialogConfig } from "../../../app/types";
import { resolveAvatarUrl } from "../../agent/avatarUtils";
import {
  type AgentPriceHint,
  formatModelCostPerMillion,
} from "../../llm/getPricing";
import { isRecord } from "../../../core/isRecord";
import { asOptionalFiniteNumber } from "../../../core/optionalNumber";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { asRecordOrEmpty } from "../../../core/recordOrEmpty";
import { asNonEmptyStringArray } from "../../../core/stringArray";
import { toTimestampMs } from "../../../core/timestamp";

type AgentCreatorRecord = Pick<
  Agent,
  "creatorName" | "originServer" | "userId" | "userName"
> & {
  authorAvatar?: unknown;
  creator?: {
    avatar?: unknown;
    avatarFileId?: unknown;
  };
  creatorAvatar?: unknown;
  userAvatar?: unknown;
};

type CreatorProfileRecord = {
  avatar?: unknown;
  avatarFileId?: unknown;
  avatarUrl?: unknown;
  name?: unknown;
  nickname?: unknown;
  username?: unknown;
};

export interface AgentDialogHistoryEntry {
  dbKey: string;
  spaceId: string | null;
  spaceName: string | null;
  title: string;
  updatedAt: unknown;
}

export type AgentThreadListSection = "running" | "future" | "recent";

export interface AgentThreadOverviewEntry extends AgentDialogHistoryEntry {
  agentKey: string | null;
  listSection: AgentThreadListSection;
  status: string | null;
  threadKind: string | null;
  runtimeEvidence?: AgentThreadRuntimeEvidence;
}

export interface AgentThreadOverviewGroups {
  running: AgentThreadOverviewEntry[];
  future: AgentThreadOverviewEntry[];
  recent: AgentThreadOverviewEntry[];
}

export type ClientAgentThreadStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type ClientAgentThreadKind =
  | "chat"
  | "background"
  | "inline"
  | "handoff"
  | "scheduled";

export type ClientAgentThreadPresentationIntent =
  | "background_handoff"
  | "inline_result"
  | "handoff_speaker";

export interface ClientAgentThread {
  threadId: string;
  dialogId?: string;
  dialogKey?: string;
  title?: string;
  summary?: string;
  primaryAgentKey: string;
  status: ClientAgentThreadStatus;
  threadKind: ClientAgentThreadKind;
  presentationIntent?: ClientAgentThreadPresentationIntent;
  parentThreadId?: string;
  rootThreadId?: string;
  section: AgentThreadListSection;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  runtimeEvidence?: AgentThreadRuntimeEvidence;
}

export interface AgentThreadRuntimeEvidence {
  status?: string;
  lastToolNames: string[];
  toolCallCount?: number;
  lastAssistantText?: string;
  errorMessage?: string;
  workspaceLease?: {
    source?: string;
    artifactKind?: string;
  };
  hasRuntimeToolPolicySnapshot: boolean;
}

export interface ClientAgentThreadsResponse {
  ok: boolean;
  data: {
    threads: ClientAgentThread[];
    bySection: Record<AgentThreadListSection, string[]>;
  };
}

export const buildAgentThreadOverviewFromApi = ({
  threads,
  untitledDialogLabel,
}: {
  threads: readonly ClientAgentThread[];
  untitledDialogLabel: string;
}): AgentThreadOverviewGroups => {
  const groups: AgentThreadOverviewGroups = {
    running: [],
    future: [],
    recent: [],
  };

  for (const thread of threads) {
    const entry: AgentThreadOverviewEntry = {
      agentKey: thread.primaryAgentKey,
      dbKey:
        toNonEmptyString(thread.dialogKey) ||
        toNonEmptyString(thread.dialogId) ||
        thread.threadId,
      listSection: thread.section,
      spaceId: null,
      spaceName: null,
      status: thread.status,
      threadKind: thread.threadKind,
      ...(thread.runtimeEvidence ? { runtimeEvidence: thread.runtimeEvidence } : {}),
      title: toNonEmptyString(thread.title) || untitledDialogLabel,
      updatedAt: thread.updatedAt,
    };
    groups[thread.section].push(entry);
  }

  return groups;
};

export const formatCliProviderLabel = (provider?: string) => {
  if (provider === "codex") return "OpenAI Codex CLI (codex exec)";
  if (provider === "gemini") return "Gemini CLI (gemini)";
  if (provider === "claude") return "Claude CLI (claude)";
  if (provider === "agy") return "Google Antigravity CLI (agy)";
  if (provider === "qoder") return "Qoder CLI (qoder)";
  if (provider === "opencode") return "OpenCode CLI (opencode)";
  if (provider === "grok") return "Grok CLI (grok)";
  if (provider === "kimi") return "Kimi Code CLI (kimi)";
  return "GitHub Copilot CLI (gh copilot)";
};

export const formatRuntimeLocationLabel = (
  machineId?: string,
  localLabel = "默认环境"
) => (machineId ? `远程电脑 (${machineId})` : localLabel);

export const toNonEmptyString = (value: unknown): string | null =>
  asOptionalTrimmedString(value) ?? null;

export const toTimestamp = toTimestampMs;

export const formatDateValue = (value: unknown, pattern: string): string => {
  const timestamp = toTimestamp(value);
  return timestamp > 0 ? format(new Date(timestamp), pattern) : "--";
};

export const shouldShowAgentTokenCost = (
  agent: Pick<Agent, "apiSource" | "inputPrice" | "outputPrice"> | null | undefined,
  priceHint: AgentPriceHint | null | undefined
) =>
  !!agent &&
  agent.apiSource !== "cli" &&
  priceHint?.type === "per_turn" &&
  (asOptionalFiniteNumber(agent.inputPrice) !== undefined ||
    asOptionalFiniteNumber(agent.outputPrice) !== undefined);

export const formatAgentOutputPrice = (outputPrice?: number) =>
  outputPrice === 0
    ? formatModelCostPerMillion(outputPrice)
    : `1M / ${formatModelCostPerMillion(outputPrice)}`;

const isAutomationRunDialog = (dialog: DialogConfig): boolean =>
  dialog.triggerType === "automation_run" ||
  dialog.triggerType === "scheduled_run" ||
  Boolean((dialog as { parentAutomationKey?: unknown }).parentAutomationKey) ||
  Boolean((dialog as { parentTaskKey?: unknown }).parentTaskKey);

export const resolveAgentCreatorSummary = ({
  item,
  creatorProfile,
  server,
  unknownUserLabel,
}: {
  creatorProfile?: CreatorProfileRecord | null;
  item: AgentCreatorRecord;
  server?: string | null;
  unknownUserLabel: string;
}) => {
  const name =
    toNonEmptyString(creatorProfile?.nickname) ||
    toNonEmptyString(creatorProfile?.name) ||
    toNonEmptyString(creatorProfile?.username) ||
    toNonEmptyString(item.userName) ||
    toNonEmptyString(item.creatorName) ||
    toNonEmptyString(item.userId) ||
    unknownUserLabel;

  const creatorAvatarRaw = toNonEmptyString(
    creatorProfile?.avatarFileId ||
      creatorProfile?.avatar ||
      creatorProfile?.avatarUrl ||
      item.creator?.avatarFileId ||
      item.creator?.avatar ||
      item.creatorAvatar ||
      item.userAvatar ||
      item.authorAvatar
  );

  return {
    avatarUrl: creatorAvatarRaw
      ? resolveAvatarUrl(creatorAvatarRaw, item.originServer || server)
      : null,
    name,
  };
};

export const buildAgentDialogHistory = ({
  historyAgentKeys,
  historySpaceNameById,
  limit = 8,
  records,
  untitledDialogLabel,
}: {
  historyAgentKeys: ReadonlySet<string>;
  historySpaceNameById: ReadonlyMap<string, string>;
  limit?: number;
  records: readonly unknown[];
  untitledDialogLabel: string;
}): AgentDialogHistoryEntry[] =>
  records
    .flatMap((record) => {
      const dialog = record as DialogConfig & {
        dbKey?: unknown;
      };
      if (isAutomationRunDialog(dialog)) return [];
      const cybots = asNonEmptyStringArray(dialog.cybots);
      if (!cybots.some((dialogAgentKey) => historyAgentKeys.has(dialogAgentKey))) {
        return [];
      }

      const dbKey = toNonEmptyString(dialog.dbKey);
      if (!dbKey) return [];

      return [
        {
          dbKey,
          spaceId: toNonEmptyString(dialog.spaceId),
          title: toNonEmptyString(dialog.title) || untitledDialogLabel,
          updatedAt: dialog.updatedAt ?? dialog.createdAt,
        },
      ];
    })
    .sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt))
    .slice(0, limit)
    .map((dialog) => ({
      ...dialog,
      spaceName: dialog.spaceId
        ? historySpaceNameById.get(dialog.spaceId) ?? dialog.spaceId
        : null,
    }));

const readAgentThreadSummary = (
  dialog: DialogConfig & { agentThread?: unknown; threadKind?: unknown }
) => {
  const summary = asRecordOrEmpty(dialog.agentThread);
  const listSection: AgentThreadListSection =
    summary.listSection === "running" ||
    summary.listSection === "future" ||
    summary.listSection === "recent"
      ? summary.listSection
      : dialog.status === "running" || dialog.status === "pending"
        ? "running"
        : "recent";

  return {
    agentKey:
      toNonEmptyString(summary.agentKey) ||
      toNonEmptyString(dialog.primaryAgentKey) ||
      null,
    listSection,
    status: toNonEmptyString(summary.status) || toNonEmptyString(dialog.status),
    threadKind: toNonEmptyString(summary.threadKind) || toNonEmptyString(dialog.threadKind),
  };
};

const buildRuntimeEvidenceFromCheckpoint = (
  checkpoint: unknown
): AgentThreadRuntimeEvidence | undefined => {
  if (!isRecord(checkpoint)) return undefined;

  const runtimeBinding = isRecord(checkpoint.runtimeBinding)
    ? checkpoint.runtimeBinding
    : undefined;
  const workspaceLease = isRecord(runtimeBinding?.workspaceLease)
    ? runtimeBinding.workspaceLease
    : undefined;
  const evidence = isRecord(workspaceLease?.evidence)
    ? workspaceLease.evidence
    : undefined;
  const lastToolNames = asNonEmptyStringArray(checkpoint.lastToolNames);
  const rawToolCallCount = checkpoint.toolCallCount;
  const toolCallCount = asOptionalFiniteNumber(rawToolCallCount);
  const runtimeToolPolicySnapshot = runtimeBinding?.runtimeToolPolicySnapshot;

  if (
    lastToolNames.length === 0 &&
    toolCallCount === undefined &&
    !workspaceLease &&
    !runtimeToolPolicySnapshot &&
    !toNonEmptyString(checkpoint.status)
  ) {
    return undefined;
  }

  return {
    ...(toNonEmptyString(checkpoint.status)
      ? { status: toNonEmptyString(checkpoint.status) ?? undefined }
      : {}),
    lastToolNames,
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
    ...(workspaceLease
      ? {
          workspaceLease: {
            ...(toNonEmptyString(workspaceLease.source)
              ? { source: toNonEmptyString(workspaceLease.source) ?? undefined }
              : {}),
            ...(toNonEmptyString(evidence?.artifactKind)
              ? { artifactKind: toNonEmptyString(evidence?.artifactKind) ?? undefined }
              : {}),
          },
        }
      : {}),
    hasRuntimeToolPolicySnapshot: isRecord(runtimeToolPolicySnapshot),
  };
};

export const buildAgentThreadOverview = ({
  historyAgentKeys,
  historySpaceNameById,
  limitPerSection = 6,
  records,
  untitledDialogLabel,
}: {
  historyAgentKeys: ReadonlySet<string>;
  historySpaceNameById: ReadonlyMap<string, string>;
  limitPerSection?: number;
  records: readonly unknown[];
  untitledDialogLabel: string;
}): AgentThreadOverviewGroups => {
  const groups: AgentThreadOverviewGroups = {
    running: [],
    future: [],
    recent: [],
  };

  const entries = records
    .flatMap((record) => {
      const dialog = record as DialogConfig & {
        agentThread?: any;
        dbKey?: unknown;
      };
      if (isAutomationRunDialog(dialog)) return [];
      const thread = readAgentThreadSummary(dialog);
      const cybots = asNonEmptyStringArray(dialog.cybots);
      const matchesAgent =
        (thread.agentKey && historyAgentKeys.has(thread.agentKey)) ||
        cybots.some((dialogAgentKey) => historyAgentKeys.has(dialogAgentKey));
      if (!matchesAgent) return [];

      const dbKey = toNonEmptyString(dialog.dbKey);
      if (!dbKey) return [];
      const runtimeEvidence = buildRuntimeEvidenceFromCheckpoint(
        (dialog as { runtimeCheckpoint?: unknown }).runtimeCheckpoint
      );

      return [
        {
          agentKey: thread.agentKey,
          dbKey,
          listSection: thread.listSection,
          spaceId: toNonEmptyString(dialog.spaceId),
          status: thread.status,
          threadKind: thread.threadKind,
          title: toNonEmptyString(dialog.title) || untitledDialogLabel,
          updatedAt: dialog.updatedAt ?? dialog.createdAt,
          ...(runtimeEvidence ? { runtimeEvidence } : {}),
        },
      ];
    })
    .sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt))
    .map((dialog) => ({
      ...dialog,
      spaceName: dialog.spaceId
        ? historySpaceNameById.get(dialog.spaceId) ?? dialog.spaceId
        : null,
    }));

  for (const entry of entries) {
    groups[entry.listSection].push(entry);
  }

  return {
    running: groups.running.slice(0, limitPerSection),
    future: groups.future.slice(0, limitPerSection),
    recent: groups.recent.slice(0, limitPerSection),
  };
};

export type AgentEmailReadinessStatus =
  | "created"
  | "warming"
  | "ready"
  | "failed_warmup";

export interface AgentEmailBindingRow {
  emailAddress: string;
  isPrimary: boolean;
  provider?: string;
  purpose?: string;
  source?: string;
  readinessStatus?: AgentEmailReadinessStatus | null;
}

export interface AgentEmailBindingSummary {
  primaryEmail: string | null;
  provider: string | null;
  identities: AgentEmailBindingRow[];
}

const normalizeAgentEmailAddress = (value: unknown): string | null => {
  const trimmed = toNonEmptyString(value);
  return trimmed ? trimmed.toLowerCase() : null;
};

export const formatAgentEmailReadinessLabel = (
  status?: AgentEmailReadinessStatus | string | null
): string => {
  switch (status) {
    case "ready":
      return "可收信";
    case "warming":
      return "预热中";
    case "failed_warmup":
      return "收信未就绪";
    case "created":
      return "已创建";
    default:
      return "";
  }
};

export const buildAgentEmailBindingSummary = (
  agent: { meta?: Record<string, unknown> } | null | undefined
): AgentEmailBindingSummary => {
  const meta = agent?.meta;
  const primaryEmail = normalizeAgentEmailAddress(meta?.emailAddress);
  const provider = toNonEmptyString(meta?.emailProvider);
  const identities: AgentEmailBindingRow[] = [];
  const seen = new Set<string>();

  const push = (raw: Record<string, unknown> | null | undefined) => {
    if (!raw || raw.disabledAt) return;
    const emailAddress = normalizeAgentEmailAddress(raw.emailAddress);
    if (!emailAddress || seen.has(emailAddress)) return;
    seen.add(emailAddress);
    identities.push({
      emailAddress,
      isPrimary: primaryEmail === emailAddress,
      provider: toNonEmptyString(raw.provider) || undefined,
      purpose: toNonEmptyString(raw.purpose) || undefined,
      source: toNonEmptyString(raw.source) || undefined,
      readinessStatus:
        typeof raw.readinessStatus === "string"
          ? (raw.readinessStatus as AgentEmailReadinessStatus)
          : null,
    });
  };

  if (primaryEmail) {
    push({
      emailAddress: primaryEmail,
      provider: meta?.emailProvider,
      readinessStatus: meta?.emailReadinessStatus,
      source: "bound",
    });
  }

  if (Array.isArray(meta?.emailIdentities)) {
    for (const entry of meta.emailIdentities) {
      if (isRecord(entry)) {
        push(entry);
      }
    }
  }

  return {
    primaryEmail,
    provider: provider || identities[0]?.provider || null,
    identities,
  };
};
