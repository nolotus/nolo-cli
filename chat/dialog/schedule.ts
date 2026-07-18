import { Cron } from "croner";
import { asTrimmedString } from "../../core/trimmedString";

export function computeNextScheduledAt(
  schedule: string | null | undefined,
  now = Date.now(),
): number | null {
  const normalizedSchedule = asTrimmedString(schedule);
  if (!normalizedSchedule) return null;

  try {
    const cron = new Cron(normalizedSchedule);
    return cron.nextRuns(1, new Date(now))[0]?.getTime() ?? null;
  } catch {
    return null;
  }
}

