import { readFileSync } from "node:fs";
import { ulid } from "ulid";

function getCliArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export function readBodyArg(args: string[], fallback = "") {
  const bodyFile = getCliArg(args, "--body-file");
  if (bodyFile !== undefined) {
    return readFileSync(bodyFile, "utf8");
  }
  return getCliArg(args, "--body") ?? fallback;
}

function textToSlate(text: string) {
  return text.split("\n").map((line) => ({
    type: "paragraph",
    children: [{ text: line }],
  }));
}

export function createPageId() {
  return ulid();
}

export function buildPageKey(userId: string, pageId: string) {
  return `page-${userId}-${pageId}`;
}

export function buildPageRecord(args: {
  dbKey: string;
  pageId: string;
  title: string;
  spaceId: string | null;
  content: string;
  existing?: Record<string, any> | null;
  meta?: Record<string, any> | null;
  slateData?: Record<string, any>[] | null;
}) {
  const { dbKey, pageId, title, spaceId, content, existing, meta, slateData } = args;
  const now = Date.now();
  const createdAt = typeof existing?.createdAt === "number" ? existing.createdAt : now;
  const created =
    typeof existing?.created === "string" ? existing.created : new Date(createdAt).toISOString();

  const nextRecord: Record<string, any> = {
    ...(existing ?? {}),
    id: existing?.id ?? pageId,
    dbKey,
    type: "page",
    title,
    spaceId,
    content,
    updatedAt: now,
    createdAt,
    created,
  };

  if (meta !== undefined) {
    if (meta === null) {
      delete nextRecord.meta;
    } else {
      nextRecord.meta = meta;
    }
  }

  if (slateData !== undefined) {
    if (slateData === null) {
      delete nextRecord.slateData;
    } else {
      nextRecord.slateData = slateData;
    }
  } else if (!existing?.slateData) {
    nextRecord.slateData = textToSlate(content);
  }

  return nextRecord;
}
