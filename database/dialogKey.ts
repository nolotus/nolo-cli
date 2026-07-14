import { DataType } from "../create/types";
import { ulid } from "./utils/ulid";

const SEPARATOR = "-";
const createKey = (...parts: (string | number)[]) => parts.join(SEPARATOR);
const splitKey = (key: string) => key.split(SEPARATOR);

export const buildDialogKey = (userId: string, dialogId: string): string =>
  createKey(DataType.DIALOG, userId, dialogId);

/** userId may contain '-': dialogId is suffix after last dash */
export const parseDialogKey = (
  key: string,
): { userId: string; dialogId: string } | null => {
  const prefix = `${DataType.DIALOG}${SEPARATOR}`;
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const lastDash = rest.lastIndexOf(SEPARATOR);
  if (lastDash <= 0 || lastDash === rest.length - 1) return null;
  return {
    userId: rest.slice(0, lastDash),
    dialogId: rest.slice(lastDash + 1),
  };
};

export const isDialogKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.DIALOG;
};

export const isDialogRecordKey = (key: string): boolean => {
  if (typeof key !== "string" || !key.startsWith(`${DataType.DIALOG}-`)) return false;
  if (key.includes("-msg-")) return false;
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.DIALOG;
};

export const isDialogRecordKeyForId = (key: string, dialogId: string): boolean => {
  if (!dialogId || !isDialogRecordKey(key)) return false;
  return key.endsWith(`${SEPARATOR}${dialogId}`);
};

export const createDialogKey = Object.assign(
  (userId: string) => createKey(DataType.DIALOG, userId, ulid()),
  {
    single: (userId: string, dialogId: string) =>
      createKey(DataType.DIALOG, userId, dialogId),
    rangeOfUser: (userId: string) => ({
      start: createKey(DataType.DIALOG, userId, ""),
      end: createKey(DataType.DIALOG, userId, "\uffff"),
    }),
  },
);

export const createDialogMessageKeyAndId = (
  dialogId: string,
  ulidFn: () => string = ulid,
): { key: string; messageId: string } => {
  const messageId = ulidFn();
  const key = createKey(DataType.DIALOG, dialogId, "msg", messageId);
  return { key, messageId };
};

/** Arg is dialogId (not full dialogKey). */
export const dialogMessagePrefix = (dialogId: string): string =>
  createKey(DataType.DIALOG, dialogId, "msg");

export const dialogMessageRange = (dialogId: string) => ({
  start: createKey(DataType.DIALOG, dialogId, "msg", ""),
  end: createKey(DataType.DIALOG, dialogId, "msg", "\uffff"),
});
