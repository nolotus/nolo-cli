// ai/context/fetchReferenceContents.ts

import { read } from "../../database/dbSlice";
import { AppDispatch } from "../../app/store";
import { slateToText } from "../../create/editor/transforms/slateToText";
import { slateToSimplifiedMarkdown } from "../../create/editor/transforms/slateToSimplifiedMarkdown";
import { extractCategorizedMentions } from "../../create/editor/utils/slateUtils";
import { DialogConfig } from "../../app/types";
import { DataType } from "../../create/types";
import { extractCustomId } from "../../core/prefix";
import { clipMultilineText } from "../../core/clipMultilineText";
import { asTrimmedString } from "../../core/trimmedString";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { fetchAndCacheMessages } from "../../chat/messages/fetchAndCacheMessages";
import { createSpaceKey } from "../../create/space/spaceKeys";
import { TableMeta } from "../../render/table/types";
import { fetchAndSerializeTable } from "../../render/table/utils/tableSerialization";
import { estimateTokenCount } from "../context/tokenUtils";
import { wrapHistoricalSummaryWithReplayGuard } from "../context/staleReplayGuard";

interface FetchOptions {
  format?: "json" | "text" | "simplified_markdown";
  inlineMentionMeta?: boolean;
  preloaded?: Map<string, any>;
}

type MentionMeta = {
  displayType?: string;
  title?: string;
  metaParts: string[] | readonly string[];
};

const MAX_META_TEXT_LENGTH = 80;
const DIALOG_REFERENCE_MESSAGE_LIMIT = 20;
const DIALOG_REFERENCE_SNIPPET_CHARS = 1200;
const DIALOG_HANDOFF_SNIPPET_CHARS = 360;

const truncateMetaText = (value: string | undefined, max = MAX_META_TEXT_LENGTH) => {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
};

const readSafe = async (dispatch: AppDispatch, dbKey: string) => {
  try {
    return await dispatch(read({
      dbKey: dbKey
    })).unwrap();
  } catch {
    return null;
  }
};

const buildMentionMetaMap = async (
  slateData: any,
  dispatch: AppDispatch
): Promise<Map<string, MentionMeta>> => {
  const metaMap = new Map<string, MentionMeta>();
  const mentions = extractCategorizedMentions(slateData);

  if (!mentions) return metaMap;

  const pageEntries = await Promise.all(
    (mentions.pages || []).map(async (pageId: string) => {
      const pageData = await readSafe(dispatch, pageId);
      if (!pageData) {
        return [`page:${pageId}`, { displayType: "page", metaParts: [] }] as const;
      }
      if (pageData.type === DataType.DIALOG) {
        const agentCount = Array.isArray(pageData.cybots)
          ? pageData.cybots.length
          : 0;
        return [
          `page:${pageId}`,
          {
            displayType: "dialog",
            title: pageData.title,
            metaParts: [
              `agents=${agentCount}`,
              `updated=${pageData.updatedAt || pageData.updated_at || pageData.updated || "Unknown"}`,
            ],
          },
        ] as const;
      }

      const tags =
        pageData.tags && pageData.tags.length > 0
          ? pageData.tags.slice(0, 5).join(", ")
          : "";
      return [
        `page:${pageId}`,
        {
          displayType: "page",
          title: pageData.title,
          metaParts: [
            pageData.spaceId ? `space=${pageData.spaceId}` : "",
            tags ? `tags=${tags}` : "",
            `updated=${pageData.updatedAt || pageData.updated_at || pageData.updated || "Unknown"}`,
          ].filter(Boolean),
        },
      ] as const;
    })
  );

  pageEntries.forEach((entry: any) => metaMap.set(entry[0], entry[1]));

  const agentEntries = await Promise.all(
    (mentions.agents || []).map(async (agentId: string) => {
      const agentData = await readSafe(dispatch, agentId);
      if (!agentData) {
        return [`agent:${agentId}`, { displayType: "agent", metaParts: [] }] as const;
      }
      const desc = truncateMetaText(
        agentData.description || agentData.introduction || ""
      );
      return [
        `agent:${agentId}`,
        {
          displayType: "agent",
          title: agentData.name,
          metaParts: [
            `public=${agentData.isPublic ? "yes" : "no"}`,
            desc ? `desc=${desc}` : "",
          ].filter(Boolean),
        },
      ] as const;
    })
  );

  agentEntries.forEach((entry: any) => metaMap.set(entry[0], entry[1]));

  const spaceEntries = await Promise.all(
    (mentions.spaces || []).map(async (spaceId: string) => {
      const spaceKey = createSpaceKey.space(spaceId);
      const spaceData = await readSafe(dispatch, spaceKey);
      if (!spaceData) {
        return [`space:${spaceId}`, { displayType: "space", metaParts: [] }] as const;
      }
      const desc = truncateMetaText(spaceData.description || "");
      const categoriesCount = Object.keys(spaceData.categories || {}).length;
      const contentsCount = Object.keys(spaceData.contents || {}).length;
      return [
        `space:${spaceId}`,
        {
          displayType: "space",
          title: spaceData.name,
          metaParts: [
            desc ? `desc=${desc}` : "",
            `categories=${categoriesCount}`,
            `contents=${contentsCount}`,
          ].filter(Boolean),
        },
      ] as const;
    })
  );

  spaceEntries.forEach((entry: any) => metaMap.set(entry[0], entry[1]));

  return metaMap;
};

const buildInlineMention = (
  node: any,
  metaMap: Map<string, MentionMeta>
): string => {
  const resourceType = node.resourceType || "unknown";
  const resourceId = node.resourceId || "unknown";
  const key = `${resourceType}:${resourceId}`;
  const meta = metaMap.get(key);
  const label = meta?.title || node.label || resourceId || "mention";
  const displayType = meta?.displayType || resourceType;
  const metaParts = (meta?.metaParts as string[]) ?? [];
  const idPart =
    resourceType === "tool" ? `tool=${resourceId}` : `dbkey=${resourceId}`;
  const metaSuffix = metaParts.length ? ` | ${metaParts.join(" | ")}` : "";
  return `@${label}(${displayType} | ${idPart}${metaSuffix})`;
};

const clipReferenceText = (value: unknown, max: number) => {
  const raw =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : JSON.stringify(value);
  return clipMultilineText(raw, max);
};

// --- Sub-handlers for specific types ---

const fetchDialogReference = async (
  dbKey: string,
  refContent: any,
  dispatch: AppDispatch
): Promise<string> => {
  const dialogConfig = refContent as DialogConfig;
  const dialogTitle = dialogConfig.title || `Untitled Dialog (${dbKey})`;
  const dialogId = extractCustomId(dbKey) || dbKey.replace(/^dialog-/, "");
  const checkpoint = (dialogConfig as any).runtimeCheckpoint || null;
  const summary = asTrimmedString((dialogConfig as any).summary);
  const proactiveSummary = asTrimmedString((dialogConfig as any).proactiveSummary);

  const messages = await dispatch(
    async (_dispatch: any, getState: any, { db }: any) => {
      const state = getState();
      const { currentToken: token, remoteServers } =
        getRuntimeServerContext(state);

      return await fetchAndCacheMessages({
        db,
        dialogId,
        limit: DIALOG_REFERENCE_MESSAGE_LIMIT,
        token,
        remoteServers: remoteServers.length > 0 ? remoteServers : undefined,
      });
    }
  );

  const sortedMessages = [...messages].reverse();
  const formatContent = (content: unknown) =>
    clipReferenceText(content, DIALOG_REFERENCE_SNIPPET_CHARS);
  const transcript = sortedMessages
    .map((msg: any, index) => {
      const toolLine = msg.toolName ? ` tool=${msg.toolName}` : "";
      const agentLine = msg.cybotKey ? ` agent=${msg.cybotKey}` : "";
      const createdLine = msg.createdAt ? ` at=${msg.createdAt}` : "";
      return [
        `### Message ${index + 1}: ${msg.role || "unknown"} id=${msg.id || "unknown"}${toolLine}${agentLine}${createdLine}`,
        formatContent(msg.content) || "[empty]",
      ].join("\n");
    })
    .join("\n\n");

  const checkpointLines: string[] = [];
  if (checkpoint && typeof checkpoint === "object") {
    if (checkpoint.status) checkpointLines.push(`- status: ${checkpoint.status}`);
    if (checkpoint.lastUserInput) checkpointLines.push(`- lastUserInput: ${formatContent(checkpoint.lastUserInput)}`);
    if (checkpoint.lastAssistantText) checkpointLines.push(`- lastAssistantText: ${formatContent(checkpoint.lastAssistantText)}`);
    if (Array.isArray(checkpoint.lastToolNames) && checkpoint.lastToolNames.length) {
      checkpointLines.push(`- lastToolNames: ${checkpoint.lastToolNames.join(", ")}`);
    }
    if (Array.isArray(checkpoint.availableToolNames) && checkpoint.availableToolNames.length) {
      checkpointLines.push(`- availableToolNames: ${checkpoint.availableToolNames.join(", ")}`);
    }
  }

  const recentToolEvidence = sortedMessages
    .filter((msg: any) => msg.role === "tool" || msg.toolName)
    .slice(-3)
    .map((msg: any) => {
      const label = msg.toolName ? `${msg.toolName}` : "tool";
      return `- ${label} id=${msg.id || "unknown"}: ${clipReferenceText(msg.content, DIALOG_HANDOFF_SNIPPET_CHARS) || "[empty]"}`;
    });

  const handoffLines = [
    `- Use this when continuing work, transferring to another Agent, comparing with the current task, or preparing a document/plan from the prior discussion.`,
    `- Current state source: ${checkpointLines.length ? "Runtime Checkpoint" : "summaries and recent transcript"}.`,
    summary ? `- Compressed background: passive summary is available below; treat it as lossy, not original wording.` : "",
    proactiveSummary ? `- Recent work: proactive summary is available below; use it for current direction, not exact evidence.` : "",
    recentToolEvidence.length
      ? `- Recent tool evidence:\n${recentToolEvidence.join("\n")}`
      : `- Recent tool evidence: none loaded in the latest ${DIALOG_REFERENCE_MESSAGE_LIMIT} messages.`,
    `- For exact claims, old decisions, original wording, files/tools mentioned earlier, or anything not visible in the recent transcript, call searchDialogMessages with DB Key ${dbKey}.`,
  ].filter(Boolean);

  const referenceBody = [
    `Conversation Reference:`,
    `DB Key: ${dbKey}`,
    `Title: ${dialogTitle}`,
    `Status: ${(dialogConfig as any).status || "unknown"}`,
    `Loaded Recent Messages: ${sortedMessages.length}`,
    `Conversation Handoff:\n${handoffLines.join("\n")}`,
    checkpointLines.length ? `Runtime Checkpoint:\n${checkpointLines.join("\n")}` : "",
    summary ? `Passive Summary (compressed history, not original wording):\n${wrapHistoricalSummaryWithReplayGuard(summary)}` : "",
    proactiveSummary ? `Proactive Summary (recent work summary, not original wording):\n${wrapHistoricalSummaryWithReplayGuard(proactiveSummary)}` : "",
    `Recent Transcript (original message excerpts, oldest to newest):\n${transcript || "[no recent messages loaded]"}`,
    [
      `Coverage Note: This reference intentionally loads only the latest ${DIALOG_REFERENCE_MESSAGE_LIMIT} messages plus summaries/checkpoint to control token load.`,
      `Original Message Lookup Policy: If the user asks for an exact old message, original wording, who said what, why a decision was made, early-history detail, file/tool evidence, failed attempts, or a comparison with prior work, use searchDialogMessages({ dialogKey: "${dbKey}", query: "..." }) before making a factual claim from this referenced conversation.`,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");

  const tokenEstimate = estimateTokenCount(referenceBody);

  return (
    `${referenceBody}\n\n` +
    `Token Load Estimate: ${tokenEstimate} tokens for this conversation reference.\n` +
    `---\n\n`
  );
};

const fetchTableReference = async (
  dbKey: string,
  refContent: any,
  dispatch: AppDispatch
): Promise<string> => {
  const tableMeta = refContent as TableMeta;
  const title = tableMeta.displayName || tableMeta.description || `Untitled Table (${dbKey})`;

  const { markdown: tableMd } = await dispatch(
    async (_dispatch: any, getState: any, { db }: any) => {
      const state = getState();
      const { currentToken: token, remoteServers } =
        getRuntimeServerContext(state);

      return await fetchAndSerializeTable(tableMeta, db, {
        token,
        remoteServers,
      });
    }
  );

  const tags = tableMeta.tags?.length ? tableMeta.tags.join(", ") : "None";
  const description = tableMeta.description || "No description provided.";

  return (
    `Reference Item (Table):\n` +
    `DB Key: ${dbKey}\n` +
    `Title: ${title}\n` +
    `Description: ${description}\n` +
    `Tags: ${tags}\n` +
    `Content (Markdown Table):\n\n${tableMd}\n` +
    `---\n\n`
  );
};

const fetchSlateReference = async (
  dbKey: string,
  refContent: any,
  dispatch: AppDispatch,
  options: FetchOptions
): Promise<string | null> => {
  if (!refContent?.slateData) return null;

  const title = refContent.title || `Untitled (${dbKey})`;
  let contentString: string;
  let contentType: string;
  const inlineMentionMeta =
    options.inlineMentionMeta ?? options.format === "simplified_markdown";

  switch (options.format) {
    case "text":
      contentType = "Plain Text";
      contentString = slateToText(refContent.slateData);
      break;
    case "simplified_markdown":
      contentType = "Simplified Markdown";
      if (inlineMentionMeta) {
        const metaMap = await buildMentionMetaMap(refContent.slateData, dispatch);
        contentString = slateToSimplifiedMarkdown(refContent.slateData, {
          mentionResolver: (node) => buildInlineMention(node, metaMap),
        });
      } else {
        contentString = slateToSimplifiedMarkdown(refContent.slateData);
      }
      break;
    case "json":
    default:
      contentType = "Slate JSON";
      contentString = JSON.stringify(refContent.slateData, null, 2);
      break;
  }

  if (
    !contentString ||
    (typeof contentString === "string" && !contentString.trim()) ||
    contentString === "[]"
  ) {
    return null;
  }

  const tags = (refContent.tags || []).length > 0 ? refContent.tags.join(", ") : "None";
  const createdAt = refContent.created || "Unknown Creation Date";
  const updatedAt = refContent.updated || "Unknown Update Date";

  return (
    `Reference Item:\n` +
    `DB Key: ${dbKey}\n` +
    `Title: ${title}\n` +
    `Content (${contentType}):\n${contentString}\n` +
    `Tags: ${tags}\n` +
    `Created At: ${createdAt}\n` +
    `Updated At: ${updatedAt}\n` +
    `---\n\n`
  );
};

/**
 * 智能地获取并格式化参考内容。
 */
export const fetchReferenceContents = async (
  references: string[],
  dispatch: AppDispatch,
  options: FetchOptions = { format: "simplified_markdown" }
): Promise<Map<string, string>> => {
  const result = new Map<string, string>();
  if (!references || references.length === 0) return result;

  const referencePromises = references.map(async (dbKey) => {
    try {
      const hasPreloaded = options.preloaded?.has(dbKey);
      const refContent = hasPreloaded
        ? options.preloaded?.get(dbKey)
        : await dispatch(read({
        dbKey: dbKey
      })).unwrap();

      if (!refContent) return null;

      let formatted: string | null = null;

      if (refContent.type === DataType.DIALOG) {
        formatted = await fetchDialogReference(dbKey, refContent, dispatch);
      } else if (refContent.type === DataType.TABLE) {
        formatted = await fetchTableReference(dbKey, refContent, dispatch);
      } else {
        formatted = await fetchSlateReference(dbKey, refContent, dispatch, options);
      }

      if (formatted) return [dbKey, formatted] as [string, string];
      return null;
    } catch (error: any) {
      console.error(`Error fetching reference ${dbKey}:`, error);
      return null;
    }
  });

  const resolved = await Promise.all(referencePromises);
  resolved.forEach((item) => {
    if (item) result.set(item[0], item[1]);
  });

  return result;
};
