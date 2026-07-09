import { extractCustomId } from "../../core/prefix";
import { selectRuntimeSnapshot } from "../../app/stateViews/runtime";
import {
  buildDialogMessageSearchResults,
  clampDialogSearchNumber,
  formatDialogMessageSearchDisplay,
  normalizeDialogSearchText,
  type DialogMessageSearchRecord,
} from "./dialogMessageSearch";

type SearchDialogMessagesArgs = {
  dialogKey: string;
  query: string;
  limit?: number;
  scanLimit?: number;
  contextMessages?: number;
  role?: "user" | "assistant" | "tool" | "system";
  includeTools?: boolean;
};

const MAX_LIMIT = 10;
const MAX_CONTEXT_MESSAGES = 3;
const MAX_CONTENT_CHARS = 1800;
const CONTEXT_CONTENT_CHARS = 600;
const SERVER_SCAN_LIMIT = 500;

const getMessageSortValue = (message: DialogMessageSearchRecord) => {
  const createdAt = message.createdAt;
  if (typeof createdAt === "number") return createdAt;
  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const id = normalizeDialogSearchText(message.id);
  return id ? id : normalizeDialogSearchText(message.dbKey);
};

async function collectDialogMessages(db: any, dialogId: string): Promise<DialogMessageSearchRecord[]> {
  if (!db?.iterator) return [];
  const prefix = `dialog-${dialogId}-msg-`;
  let iterator = db.iterator({
    gte: prefix,
    lte: `${prefix}\uffff`,
  });
  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }

  const messages: DialogMessageSearchRecord[] = [];
  for await (const [key, value] of iterator) {
    if (!value || typeof value !== "object") continue;
    messages.push({
      ...(value as DialogMessageSearchRecord),
      dbKey: (value as DialogMessageSearchRecord).dbKey || String(key),
    });
  }

  return messages.sort((a, b) => {
    const left = getMessageSortValue(a);
    const right = getMessageSortValue(b);
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right));
  });
}

async function fetchDialogMessagesFromServer(args: {
  serverBase: string;
  token?: string;
  dialogId: string;
  limit: number;
}): Promise<DialogMessageSearchRecord[]> {
  const serverBase = args.serverBase.replace(/\/+$/, "");
  if (!serverBase || !args.token) return [];

  const response = await fetch(`${serverBase}/rpc/getConvMsgs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ dialogId: args.dialogId, limit: args.limit }),
  });
  if (!response.ok) return [];

  const newestFirst = await response.json();
  if (!Array.isArray(newestFirst)) return [];
  return [...newestFirst].reverse().map((message) => ({
    ...(message as DialogMessageSearchRecord),
    dbKey: (message as DialogMessageSearchRecord).dbKey,
  }));
}

async function collectBestAvailableDialogMessages(
  db: any,
  dialogId: string,
  thunkApi: any,
  scanLimit: number,
): Promise<DialogMessageSearchRecord[]> {
  const localMessages = await collectDialogMessages(db, dialogId);
  const state = thunkApi?.getState?.();
  const runtime = state ? selectRuntimeSnapshot(state) : null;
  const serverBases = Array.from(new Set([
    runtime?.localRuntimeOrigin,
    runtime?.currentServer,
    ...(Array.isArray(runtime?.syncServers) ? runtime.syncServers : []),
  ].filter((base): base is string => typeof base === "string" && base.trim().length > 0)));

  let bestMessages = localMessages;
  for (const serverBase of serverBases) {
    const serverMessages = await fetchDialogMessagesFromServer({
      serverBase,
      token: runtime?.currentToken,
      dialogId,
      limit: scanLimit,
    }).catch(() => []);
    if (serverMessages.length > bestMessages.length) {
      bestMessages = serverMessages;
    }
  }

  return bestMessages;
}

export const searchDialogMessagesFunctionSchema = {
  name: "searchDialogMessages",
  description: [
    "Search original messages inside a specific dialog by exact or fuzzy text.",
    "Use this when a user asks for an exact old message, original wording, who said what, why a decision was made, early-history detail, failed attempts, files or tool evidence, or comparison with prior work from an attached conversation.",
    "Prefer this over answering from a lossy dialog summary when the user needs evidence, provenance, or a specific prior detail.",
    "Returns matching message ids, roles, clipped original content, and nearby context without loading the full dialog into the model context.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      dialogKey: {
        type: "string",
        description: "Dialog dbKey, for example dialog-userId-01ABC...",
      },
      query: {
        type: "string",
        description: "Text to search for in original message content.",
      },
      limit: {
        type: "number",
        description: `Maximum matches to return. Capped at ${MAX_LIMIT}.`,
      },
      scanLimit: {
        type: "number",
        description: `Maximum messages to scan when fetching from a server. Capped at ${SERVER_SCAN_LIMIT}.`,
      },
      contextMessages: {
        type: "number",
        description: `Number of neighboring messages before/after each match. Capped at ${MAX_CONTEXT_MESSAGES}.`,
      },
      role: {
        type: "string",
        enum: ["user", "assistant", "tool", "system"],
        description: "Optional role filter.",
      },
      includeTools: {
        type: "boolean",
        description: "Whether tool messages may match. Defaults to true.",
      },
    },
    required: ["dialogKey", "query"],
  },
};

export async function searchDialogMessagesFunc(
  args: SearchDialogMessagesArgs,
  _thunkApi: any,
  context?: {
    parentMessageId?: string;
    signal?: AbortSignal;
    toolRunId?: string;
    agentKey?: string;
    userInput?: string;
    db?: any;
  }
) {
  const dialogKey = normalizeDialogSearchText(args?.dialogKey);
  const query = normalizeDialogSearchText(args?.query);
  if (!dialogKey.startsWith("dialog-")) {
    throw new Error("searchDialogMessages requires a dialog-* dbKey.");
  }
  if (!query) {
    throw new Error("searchDialogMessages requires a non-empty query.");
  }

  const db = context?.db ?? _thunkApi?.extra?.db;
  if (!db) {
    throw new Error("searchDialogMessages cannot access the local message database.");
  }

  const dialogId = extractCustomId(dialogKey) || dialogKey.split("-").at(-1) || "";
  const scanLimit = clampDialogSearchNumber(
    args.scanLimit,
    SERVER_SCAN_LIMIT,
    1,
    SERVER_SCAN_LIMIT,
  );
  const messages = await collectBestAvailableDialogMessages(db, dialogId, _thunkApi, scanLimit);
  const limit = clampDialogSearchNumber(args.limit, 5, 1, MAX_LIMIT);
  const contextMessages = clampDialogSearchNumber(args.contextMessages, 1, 0, MAX_CONTEXT_MESSAGES);

  const results = buildDialogMessageSearchResults({
    messages,
    query,
    limit,
    contextMessages,
    role: args.role,
    includeTools: args.includeTools,
    contentClipChars: MAX_CONTENT_CHARS,
    contextClipChars: CONTEXT_CONTENT_CHARS,
  });

  const displayData = formatDialogMessageSearchDisplay({ dialogKey, query, results });

  return {
    rawData: {
      success: true,
      dialogKey,
      query,
      scannedMessages: messages.length,
      matches: results,
    },
    displayData,
  };
}
