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
  const getDefaultDb = async () => (await import("../../database-engine/db")).default;
  return writeMemoryItemWithIndexesToDb(await getDefaultDb(), item);
};

export const touchMemoryItems = async (
  items: MemoryItem[],
  now = new Date().toISOString()
): Promise<void> => {
  const getDefaultDb = async () => (await import("../../database-engine/db")).default;
  return touchMemoryItemsInDb(await getDefaultDb(), items, now);
};
