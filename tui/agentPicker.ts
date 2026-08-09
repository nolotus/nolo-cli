import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import { resolveCliAgentKeyInput } from "../agentAliases";
import type { CliFetchImpl } from "../cliFetch";
import {
  findAgentCatalogEntry,
  formatAgentSourceLabel,
  loadAgentCatalog,
  renderAgentCatalogList,
  type AgentCatalogEntry,
} from "./agentCatalog";
import { runSelectDialog, outputIsTty, type SelectDialogItem } from "./selectDialog";
import { t } from "./i18n";

type EnvLike = Record<string, string | undefined>;

export type AgentPickerItem = SelectDialogItem & {
  entry: AgentCatalogEntry;
};

export function toAgentPickerItems(entries: AgentCatalogEntry[]): AgentPickerItem[] {
  return entries.map((entry) => ({
    label: entry.name,
    detail: `${entry.favoritedAt ? "★ " : ""}${entry.model}  ${formatAgentSourceLabel(entry)}`,
    entry,
  }));
}

export function formatAgentSwitchMessage(args: {
  name: string;
  dialogId?: string;
}) {
  const dialog = args.dialogId ? `Dialog kept: ${args.dialogId}` : "Dialog kept: new";
  return `Switched to ${args.name}. ${dialog}`;
}

export async function runAgentPicker(args: {
  currentKey: string;
  env?: EnvLike;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
  readKey?: () => Promise<string | null>;
  interactive?: boolean;
  /** Dock the list above the composer; see runSelectDialog.bottomAnchored. */
  bottomAnchored?: boolean;
  bottomRow?: number | (() => number);
}) {
  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const interactive =
    args.interactive ??
    ("isTTY" in input && Boolean(input.isTTY) && "isTTY" in output && Boolean(output.isTTY));

  // 加载期间显示提示，网络快时一闪而过，慢时给用户反馈。
  const isTty = outputIsTty(output);
  if (isTty) {
    output.write(t("agentPickerLoading"));
  }

  let entries: Awaited<ReturnType<typeof loadAgentCatalog>>;
  try {
    entries = await loadAgentCatalog({
      env: args.env,
      currentKey: args.currentKey,
      fetchImpl: args.fetchImpl,
      fallbackFetchImpl: args.fallbackFetchImpl,
    });
  } finally {
    // 清除 loading 提示行（异常时也不残留）。
    if (isTty) {
      output.write("\r\x1b[2K");
    }
  }

  if (!interactive) {
    return {
      kind: "list" as const,
      output: renderAgentCatalogList(entries, args.currentKey),
      entries,
    };
  }

  const items = toAgentPickerItems(entries);
  const initialIndex = Math.max(
    entries.findIndex((entry) => entry.key === args.currentKey),
    0
  );
  const result = await runSelectDialog({
    items,
    initialIndex,
    title: undefined,
    input,
    output,
    readKey: args.readKey,
    bottomAnchored: args.bottomAnchored,
    bottomRow: args.bottomRow,
  });
  if (result.kind === "cancelled") {
    return { kind: "cancelled" as const, entries };
  }

  const selected = result.item.entry;
  return {
    kind: "selected" as const,
    name: selected.name,
    key: selected.key,
    model: selected.model,
    apiSource: selected.apiSource ?? (selected.kind === "platform" ? "platform" : undefined),
    entries,
  };
}

export function resolveAgentSwitchTarget(
  rawTarget: string,
  catalogEntries: AgentCatalogEntry[] = []
) {
  const resolvedKey = resolveCliAgentKeyInput(rawTarget);
  if (resolvedKey !== rawTarget.trim()) {
    const aliasEntry = catalogEntries.find((entry) => entry.key === resolvedKey);
    return {
      name: aliasEntry?.name ?? asTrimmedLowercaseString(rawTarget),
      key: resolvedKey,
      ...(aliasEntry?.model ? { model: aliasEntry.model } : {}),
      ...(aliasEntry
        ? {
            ...(aliasEntry.apiSource
              ? { apiSource: aliasEntry.apiSource }
              : aliasEntry.kind === "platform"
                ? { apiSource: "platform" }
                : {}),
          }
        : {}),
    };
  }
  return findAgentCatalogEntry(catalogEntries, rawTarget);
}