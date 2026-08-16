const pad2 = (value: number): string => String(value).padStart(2, "0");

const resolveDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const partsForTimeZone = (date: Date, timeZone: string): Record<string, string> => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
};

const zonedDateTime = (date: Date, timeZone: string): string => {
  const parts = partsForTimeZone(date, timeZone);
  return [
    `${parts.year}-${parts.month}-${parts.day}`,
    `${parts.hour}:${parts.minute}:${parts.second}`,
  ].join(" ");
};

const timeZoneOffset = (date: Date, timeZone: string): string => {
  const parts = partsForTimeZone(date, timeZone);
  const utcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((utcMs - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
};

/**
 * Truncate a `YYYY-MM-DD HH:MM:SS` / `YYYY-MM-DDTHH:MM:SSZ` string to hour
 * precision, preserving whatever separator sits at index 10 (space or `T`).
 *
 * Prompt-cache rationale: this block sits in the *dynamic* suffix of the system
 * message, ahead of the conversation history. Minute precision changed the
 * prefix every 60s, invalidating the downstream cache breakpoint on almost
 * every turn of a long session. Hour precision keeps the block byte-identical
 * across a typical 5-minute ephemeral cache window while still telling the
 * model the time of day. Exact minute/second is available on demand via a
 * shell `date` call.
 */
const toHourPrecision = (dateTime: string): string =>
  `${dateTime.slice(0, 13)}:00`;

export const buildCurrentTimeBlock = (
  now: Date = new Date(),
  timeZone: string = resolveDefaultTimeZone(),
): string => [
  "--- 当前时间 ---",
  `当前日期: ${zonedDateTime(now, timeZone).slice(0, 10)}`,
  `当前本地时间: ${toHourPrecision(zonedDateTime(now, timeZone))}`, // hour precision — see toHourPrecision
  `本地时区: ${timeZone} / ${timeZoneOffset(now, timeZone)}`,
  `UTC 时间: ${toHourPrecision(now.toISOString())}`, // hour precision; slice keeps the "T"
  "注意：上面的时间只精确到小时（为命中 prompt 缓存而降低粒度）。需要精确到分钟或秒时，用 shell 执行 `date` 获取。",
  "当用户问“现在”“当前时间”“北京时间”等时间问题时，直接使用这里的当前时间；不要只回答日期。",
  "当用户说“今天”“今日”或 today 时，默认指当前本地日期，除非用户明确给出其它日期。",
].join("\n");
