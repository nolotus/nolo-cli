type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

interface ClientLogger {
  debug(message: string): void;
  debug(fields: LogFields, message?: string): void;
  info(message: string): void;
  info(fields: LogFields, message?: string): void;
  warn(message: string): void;
  warn(fields: LogFields, message?: string): void;
  error(message: string): void;
  error(fields: LogFields, message?: string): void;
  child(fields: LogFields): ClientLogger;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const serializeValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value !== "object" || value === null) {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, serializeValue(item, seen)])
  );
};

const getLogLevel = (): number => {
  const configured =
    typeof process !== "undefined" && typeof process.env?.NOLO_LOG_LEVEL === "string"
      ? process.env.NOLO_LOG_LEVEL
      : "info";
  return LOG_LEVELS[configured as LogLevel] ?? LOG_LEVELS.info;
};

const writeLog = (
  level: LogLevel,
  name: string,
  fields: LogFields,
  message?: string
): void => {
  if (LOG_LEVELS[level] < getLogLevel()) {
    return;
  }

  const serializedFields = serializeValue(fields) as LogFields;
  const payload = {
    level,
    ...(name ? { name } : {}),
    ...serializedFields,
    ...(message ? { msg: message } : {}),
  };
  const output = JSON.stringify(payload);
  const isNodeRuntime =
    typeof process !== "undefined" &&
    typeof process.stderr?.write === "function";

  if (isNodeRuntime) {
    process.stderr.write(`${output}\n`);
    return;
  }

  const consoleMethod = console[level] ?? console.log;
  if (Object.keys(fields).length === 0 && message) {
    consoleMethod(`[${name}] ${message}`);
  } else {
    consoleMethod(output);
  }
};

const parseArgs = (
  first?: LogFields | string,
  second?: string
): { fields: LogFields; message?: string } => {
  if (typeof first === "string") {
    return { fields: {}, message: first };
  }
  return { fields: first ?? {}, message: second };
};

export const createClientLogger = (
  name: string,
  parentFields: LogFields = {}
): ClientLogger => {
  const log = (level: LogLevel, first?: LogFields | string, second?: string) => {
    const { fields, message } = parseArgs(first, second);
    writeLog(level, name, { ...parentFields, ...fields }, message);
  };

  return {
    debug: (first: LogFields | string, second?: string) =>
      log("debug", first, second),
    info: (first: LogFields | string, second?: string) =>
      log("info", first, second),
    warn: (first: LogFields | string, second?: string) =>
      log("warn", first, second),
    error: (first: LogFields | string, second?: string) =>
      log("error", first, second),
    child: (fields: LogFields) =>
      createClientLogger(name, { ...parentFields, ...fields }),
  };
};
