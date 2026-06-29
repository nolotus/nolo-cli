import type { PermissionRequest } from "../../agent-runtime/actionGate";
import {
  runSelectDialog,
  type KeyReader,
  type SelectDialogItem,
} from "./selectDialog";

type ConfirmDialogItem = SelectDialogItem & {
  value: boolean;
};

export async function runConfirmDialog(args: {
  request: PermissionRequest;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  readKey?: KeyReader;
}): Promise<boolean> {
  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const interactive = Boolean(input.isTTY && output.isTTY);
  if (!interactive) {
    return false;
  }

  const items: ConfirmDialogItem[] = [
    { label: "Allow", detail: "execute this time", value: true },
    { label: "Cancel", detail: "abort the operation", value: false },
  ];

  const title = [
    args.request.title,
    args.request.body,
    "(↑↓ Enter Esc)",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await runSelectDialog({
    items,
    initialIndex: 1,
    title,
    input,
    output,
    ...(args.readKey ? { readKey: args.readKey } : {}),
  });

  if (result.kind === "cancelled") {
    return false;
  }

  return (result.item as ConfirmDialogItem).value;
}
