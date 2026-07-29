import serverDb from "../../database-engine/db";
import type { MemoryItem } from "./types";
import {
  adjustMemoryConfidenceInDb,
  createMemoryItem,
  touchMemoryItemsInDb,
  writeMemoryItemWithIndexesToDb,
} from "./storeShared";

export {
  adjustMemoryConfidenceInDb,
  createMemoryItem,
  writeMemoryItemWithIndexesToDb,
  touchMemoryItemsInDb,
};

export const writeMemoryItemWithIndexes = async (item: MemoryItem): Promise<void> => {
  return writeMemoryItemWithIndexesToDb(serverDb, item);
};

export const touchMemoryItems = async (
  items: MemoryItem[],
  now = new Date().toISOString()
): Promise<void> => {
  return touchMemoryItemsInDb(serverDb, items, now);
};
