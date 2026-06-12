export type DialogMessageSearchRecord = {
  id?: string;
  dbKey?: string;
  role?: string;
  content?: unknown;
  toolName?: string;
  createdAt?: string | number;
};

export type DialogMessageSearchResult = {
  messageId: string | null;
  dbKey: string | null;
  role: string | null;
  toolName: string | null;
  createdAt: string | number | null;
  content: string;
  context: Array<{
    messageId: string | null;
    role: string | null;
    toolName: string | null;
    createdAt: string | number | null;
    content: string;
  }>;
};

export const normalizeDialogSearchText = (value: unknown): string =>
  String(value ?? "").trim();

export const clampDialogSearchNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = Number(value ?? fallback);
  const safe = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(min, Math.min(max, safe));
};

export const buildDialogSearchMatcher = (query: string) => {
  const normalizedQuery = query.toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return (text: string) => {
    const normalizedText = text.toLowerCase();
    return normalizedText.includes(normalizedQuery) ||
      (terms.length > 1 && terms.every((term) => normalizedText.includes(term)));
  };
};

export const dialogMessageContentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return JSON.stringify(part);
    }).join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
};

export const clipDialogSearchText = (value: string, max: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n...[truncated ${trimmed.length - max} chars]`;
};

export const buildDialogMessageSearchResults = (args: {
  messages: DialogMessageSearchRecord[];
  query: string;
  limit: number;
  contextMessages: number;
  role?: string;
  includeTools?: boolean;
  contentClipChars: number;
  contextClipChars: number;
}): DialogMessageSearchResult[] => {
  const matchesQuery = buildDialogSearchMatcher(args.query);
  const includeTools = args.includeTools !== false;

  return args.messages
    .map((message, index) => ({
      message,
      index,
      text: dialogMessageContentToText(message.content),
    }))
    .filter(({ message, text }) => {
      if (!includeTools && message.role === "tool") return false;
      if (args.role && message.role !== args.role) return false;
      return matchesQuery(text);
    })
    .slice(0, args.limit)
    .map(({ message, index, text }) => {
      const start = Math.max(0, index - args.contextMessages);
      const end = Math.min(args.messages.length, index + args.contextMessages + 1);
      return {
        messageId: message.id ?? null,
        dbKey: message.dbKey ?? null,
        role: message.role ?? null,
        toolName: message.toolName ?? null,
        createdAt: message.createdAt ?? null,
        content: clipDialogSearchText(text, args.contentClipChars),
        context: args.messages.slice(start, end).map((item) => ({
          messageId: item.id ?? null,
          role: item.role ?? null,
          toolName: item.toolName ?? null,
          createdAt: item.createdAt ?? null,
          content: clipDialogSearchText(
            dialogMessageContentToText(item.content),
            args.contextClipChars,
          ),
        })),
      };
    });
};

export const formatDialogMessageSearchDisplay = (args: {
  dialogKey: string;
  query: string;
  results: DialogMessageSearchResult[];
}): string => {
  if (!args.results.length) {
    return `No original dialog messages matched "${args.query}" in ${args.dialogKey}.`;
  }

  return [
    `Found ${args.results.length} message match(es) in ${args.dialogKey} for "${args.query}".`,
    ...args.results.map((item, index) =>
      [
        `Match ${index + 1}: ${item.role ?? "unknown"} id=${item.messageId ?? "unknown"}${item.toolName ? ` tool=${item.toolName}` : ""}`,
        item.content,
      ].join("\n")
    ),
  ].join("\n\n");
};
