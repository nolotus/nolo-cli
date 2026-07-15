import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import { resolveCliAgentKeyInput } from "../agentAliases";
import type { CliFetchImpl } from "../cliFetch";
import {
  findAgentCatalogEntry,
  loadAgentCatalog,
  renderAgentCatalogList,
  type AgentCatalogEntry,
} from "./agentCatalog";
import { runSelectDialog, type SelectDialogItem } from "./selectDialog";

type EnvLike = Record<string, string | undefined>;

export type AgentPickerItem = SelectDialogItem & {
  entry: AgentCatalogEntry;
};

export function toAgentPickerItems(entries: AgentCatalogEntry[]): AgentPickerItem[] {
  return entries.map((entry) => ({
    label: entry.name,
    detail: `${entry.model}  ${entry.kind}`,
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
}) {
  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const interactive =
    args.interactive ??
    Boolean((input as any).isTTY && (output as any).isTTY);
  const entries = await loadAgentCatalog({
    env: args.env,
    currentKey: args.currentKey,
    fetchImpl: args.fetchImpl,
    fallbackFetchImpl: args.fallbackFetchImpl,
  });

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
  });

  if (result.kind === "cancelled") {
    return { kind: "cancelled" as const, entries };
  }

  const selected = result.item.entry;
  return {
    kind: "selected" as const,
    name: selected.name,
    key: selected.key,
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
    };
  }
  return findAgentCatalogEntry(catalogEntries, rawTarget);
}