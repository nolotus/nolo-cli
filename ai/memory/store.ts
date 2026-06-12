import serverDb from "../../database/server/db";
import type { MemoryItem } from "./types";
import {
  createMemoryItem,
  touchMemoryItemsInDb,
  writeMemoryItemWithIndexesToDb,
} from "./storeShared";

export { createMemoryItem, writeMemoryItemWithIndexesToDb, touchMemoryItemsInDb };

export const writeMemoryItemWithIndexes = async (item: MemoryItem): Promise<void> => {
  return writeMemoryItemWithIndexesToDb(serverDb, item);
};

export const touchMemoryItems = async (
  items: MemoryItem[],
  now = new Date().toISOString()
): Promise<void> => {
  return touchMemoryItemsInDb(serverDb, items, now);
};
