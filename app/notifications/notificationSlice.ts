import { createSelector, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type {
  NotificationKind,
  NotificationRecord,
} from "../notifications/model";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  message?: string;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  href?: string;
  dialogId?: string;
  spaceId?: string;
  record: NotificationRecord;
};

type NotificationState = {
  items: AppNotification[];
  /** true after the first successful hydrate; prevents duplicate remote fetches
   *  when multiple components mount useUserNotifications. */
  hydrated: boolean;
};

const MAX_NOTIFICATION_ITEMS = 100;

const initialState: NotificationState = {
  items: [],
  hydrated: false,
};

const sortItems = (items: AppNotification[]): AppNotification[] =>
  [...items].sort((left, right) => {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.updatedAt - left.updatedAt;
  });

const dedupeItems = (items: AppNotification[]): AppNotification[] => {
  const nextMap = new Map<string, AppNotification>();
  for (const item of items) {
    const existing = nextMap.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) {
      nextMap.set(item.id, item);
    }
  }
  return Array.from(nextMap.values());
};

const notificationSlice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    replaceNotifications: (
      state,
      action: PayloadAction<AppNotification[]>
    ) => {
      state.items = sortItems(dedupeItems(action.payload)).slice(
        0,
        MAX_NOTIFICATION_ITEMS
      );
      state.hydrated = true;
    },
    addNotification: (state, action: PayloadAction<AppNotification>) => {
      const next = action.payload;
      const existingIndex = state.items.findIndex((item) => item.id === next.id);
      if (existingIndex >= 0) {
        const prev = state.items[existingIndex];
        state.items[existingIndex] = {
          ...next,
          read: prev.read || next.read,
          record: {
            ...next.record,
            readAt:
              typeof prev.record.readAt === "number"
                ? prev.record.readAt
                : next.record.readAt,
          },
        };
      } else {
        state.items.unshift(next);
      }
      state.items = sortItems(state.items).slice(0, MAX_NOTIFICATION_ITEMS);
    },
    markNotificationRead: (
      state,
      action: PayloadAction<{ id: string; readAt: number }>
    ) => {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      item.read = true;
      item.updatedAt = Math.max(item.updatedAt, action.payload.readAt);
      item.record = {
        ...item.record,
        readAt: action.payload.readAt,
        updatedAt: Math.max(item.record.updatedAt, action.payload.readAt),
      };
    },
    markAllNotificationsRead: (
      state,
      action: PayloadAction<{ readAt: number }>
    ) => {
      state.items.forEach((item) => {
        item.read = true;
        item.updatedAt = Math.max(item.updatedAt, action.payload.readAt);
        item.record = {
          ...item.record,
          readAt: action.payload.readAt,
          updatedAt: Math.max(item.record.updatedAt, action.payload.readAt),
        };
      });
    },
  },
});

export const {
  replaceNotifications,
  addNotification,
  markNotificationRead,
  markAllNotificationsRead,
} = notificationSlice.actions;

const selectNotificationState = (state: any) =>
  state.notifications ?? initialState;

export const selectNotifications = createSelector(
  selectNotificationState,
  (notifications) => sortItems(notifications.items)
);

export const selectUnreadNotifications = createSelector(
  selectNotifications,
  (items) => items.filter((item) => item.read === false)
);

export const selectUnreadNotificationCount = createSelector(
  selectUnreadNotifications,
  (items) => items.length
);

export const selectNotificationsHydrated = createSelector(
  selectNotificationState,
  (notifications) => notifications.hydrated
);

export default notificationSlice.reducer;
