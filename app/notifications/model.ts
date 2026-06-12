import { DataType } from "../../create/types";
import { createNotificationKey } from "../../database/keys";

export type NotificationKind =
  | "space_member_added"
  | "dialog_done"
  | "dialog_failed"
  | "agent_notice";

export interface NotificationRecord {
  dbKey: string;
  type: DataType.NOTIFICATION;
  userId: string;
  notificationId: string;
  kind: NotificationKind;
  createdAt: number;
  updatedAt: number;
  href?: string;
  spaceId?: string;
  dialogId?: string;
  sourceUserId?: string;
  readAt?: number | null;
  archivedAt?: number | null;
  payload?: Record<string, unknown>;
  deletedAt?: number | string;
  serverOrigin?: string;
}

export interface NotificationEventPayload {
  type: "notification.upsert";
  notification: NotificationRecord;
}

export const NOTIFICATION_LIMIT = 100;

export const createNotificationRecord = ({
  userId,
  notificationId,
  kind,
  createdAt,
  updatedAt = createdAt,
  href,
  spaceId,
  dialogId,
  sourceUserId,
  readAt,
  archivedAt,
  payload,
}: {
  userId: string;
  notificationId: string;
  kind: NotificationKind;
  createdAt: number;
  updatedAt?: number;
  href?: string;
  spaceId?: string;
  dialogId?: string;
  sourceUserId?: string;
  readAt?: number | null;
  archivedAt?: number | null;
  payload?: Record<string, unknown>;
}): NotificationRecord => ({
  dbKey: createNotificationKey.single(userId, notificationId),
  type: DataType.NOTIFICATION,
  userId,
  notificationId,
  kind,
  createdAt,
  updatedAt,
  ...(href ? { href } : {}),
  ...(spaceId ? { spaceId } : {}),
  ...(dialogId ? { dialogId } : {}),
  ...(sourceUserId ? { sourceUserId } : {}),
  ...(typeof readAt === "number" ? { readAt } : {}),
  ...(typeof archivedAt === "number" ? { archivedAt } : {}),
  ...(payload ? { payload } : {}),
});
