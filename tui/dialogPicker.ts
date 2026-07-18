import type { CliFetchImpl } from "../cliFetch";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "../cliEnvHelpers";
import { listUserRecordsFromServers } from "../globalRecordOperations";
import {
  isScheduledDialog,
  normalizeDialogRecord,
  readDialogSnapshot,
  sortDialogs,
  type ListedDialog,
} from "../dialogCommands";
import { serializeMessageContent } from "../chat/messages/messageContent";
import { clipCompactText } from "../core/clipCompactText";
import { t } from "./i18n";
import { runSelectDialog, type KeyReader, type SelectDialogItem } from "./selectDialog";

type EnvLike = Record<string, string | undefined>;

const DEFAULT_PICKER_LIMIT = 20;

export type DialogPickerItem = SelectDialogItem & {
  dialog: ListedDialog;
};

/** Compact "3m/2h/5d ago" stamp; absolute date once it is over a month old. */
export function formatDialogTimestamp(
  value: string | number | null,
  now = Date.now(),
): string {
  if (value == null) return "";
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) return "";
  const deltaSeconds = Math.max(0, Math.floor((now - time) / 1000));
  if (deltaSeconds < 60) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  if (deltaSeconds < 30 * 86400) return `${Math.floor(deltaSeconds / 86400)}d ago`;
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toDialogPickerItems(dialogs: ListedDialog[]): DialogPickerItem[] {
  return dialogs.map((dialog) => {
    const stamp = formatDialogTimestamp(dialog.updatedAt ?? dialog.createdAt);
    return {
      label: clipCompactText(dialog.title, 48, "…"),
      detail: stamp,
      dialog,
    };
  });
}

export function renderDialogList(dialogs: ListedDialog[]): string {
  if (dialogs.length === 0) return t("noDialogsYet");
  const lines = ["Recent dialogs:"];
  for (const [index, dialog] of dialogs.entries()) {
    const stamp = formatDialogTimestamp(dialog.updatedAt ?? dialog.createdAt);
    lines.push(
      `  ${index + 1}  ${clipCompactText(dialog.title, 48, "…")}${stamp ? `  ${stamp}` : ""}`,
      `     id=${dialog.id}`,
    );
  }
  lines.push("", "Tip: run /history to pick one interactively, or paste an id after /resume.");
  return lines.join("\n");
}

export async function fetchRecentDialogs(args: {
  env: EnvLike;
  fetchImpl?: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
  limit?: number;
}): Promise<{ dialogs: ListedDialog[] } | { error: string }> {
  const authToken = resolveAuthToken(args.env);
  if (!authToken) {
    return { error: t("historyNoToken") };
  }
  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    return { error: t("historyBadToken") };
  }
  const serverUrls = resolveServerCandidates(args.env, resolveServerUrl(args.env));
  const result = await listUserRecordsFromServers({
    authToken,
    fetchImpl: args.fetchImpl ?? fetch,
    fallbackFetchImpl: args.fallbackFetchImpl,
    label: "dialog query",
    serverUrls,
    type: "dialog",
    userId,
  });
  const dialogs = sortDialogs(
    result.records
      .map((record) => normalizeDialogRecord(record))
      .filter((dialog): dialog is ListedDialog => dialog != null)
      .filter((dialog) => !isScheduledDialog(dialog)),
  ).slice(0, Math.max(1, args.limit ?? DEFAULT_PICKER_LIMIT));
  return { dialogs };
}

export type DialogPickerResult =
  | { kind: "selected"; dialog: ListedDialog }
  | { kind: "cancelled" }
  | { kind: "list"; output: string }
  | { kind: "error"; message: string };

export type DialogHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export async function loadDialogHistory(args: {
  dialog: ListedDialog;
  env: EnvLike;
  fetchImpl?: CliFetchImpl;
}): Promise<DialogHistoryTurn[]> {
  const authToken = resolveAuthToken(args.env);
  if (!authToken) throw new Error(t("historyNoToken"));

  const read = await readDialogSnapshot({
    authToken,
    base: resolveServerUrl(args.env),
    dialogId: args.dialog.id,
    dialogKey: args.dialog.dbKey,
    fetchImpl: args.fetchImpl ?? fetch,
    limit: 0,
  });
  const messages = Array.isArray(read.msgs) ? [...read.msgs].reverse() : [];
  const turns: DialogHistoryTurn[] = [];
  for (const message of messages) {
    const role = message?.role ?? message?.authorRole;
    if (role !== "user" && role !== "assistant") continue;
    const content = serializeMessageContent(message?.content, "[image]");
    if (content) turns.push({ role, content });
  }
  return turns;
}

export async function runDialogPicker(args: {
  env?: EnvLike;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
  readKey?: KeyReader;
  interactive?: boolean;
  limit?: number;
  /** Dock the list above the composer; see runSelectDialog.bottomAnchored. */
  bottomAnchored?: boolean;
  bottomRow?: number;
}): Promise<DialogPickerResult> {
  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const interactive =
    args.interactive ??
    ("isTTY" in input && Boolean(input.isTTY) && "isTTY" in output && Boolean(output.isTTY));

  const fetched = await fetchRecentDialogs({
    env: args.env ?? process.env,
    fetchImpl: args.fetchImpl,
    fallbackFetchImpl: args.fallbackFetchImpl,
    limit: args.limit,
  });
  if ("error" in fetched) {
    return { kind: "error", message: fetched.error };
  }
  if (!interactive || fetched.dialogs.length === 0) {
    return { kind: "list", output: renderDialogList(fetched.dialogs) };
  }

  const items = toDialogPickerItems(fetched.dialogs);
  const result = await runSelectDialog({
    items,
    title: `${t("historyPickerTitle")}  ${items.length}`,
    input,
    output,
    readKey: args.readKey,
    bottomAnchored: args.bottomAnchored,
    bottomRow: args.bottomRow,
  });
  if (result.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  return { kind: "selected", dialog: result.item.dialog };
}
