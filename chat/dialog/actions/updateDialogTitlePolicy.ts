import { differenceInMinutes } from "date-fns";

export const TITLE_UPDATE_INTERVAL_MINUTES = 30;

const FORCE_UPDATE_FOR_TEST = false;

export const shouldUpdateTitle = (
  createdAt?: string,
  lastUpdatedAt?: string,
  now = new Date()
): boolean => {
  if (FORCE_UPDATE_FOR_TEST) return true;

  const lastUpdate = lastUpdatedAt ? new Date(lastUpdatedAt) : null;
  const creation = createdAt ? new Date(createdAt) : null;

  if (
    !lastUpdate ||
    !creation ||
    Number.isNaN(lastUpdate.getTime()) ||
    Number.isNaN(creation.getTime())
  ) {
    return true;
  }

  return (
    differenceInMinutes(now, creation) <= TITLE_UPDATE_INTERVAL_MINUTES ||
    differenceInMinutes(now, lastUpdate) >= TITLE_UPDATE_INTERVAL_MINUTES
  );
};
