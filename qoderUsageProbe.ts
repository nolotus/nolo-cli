import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type QoderQuotaUsage = {
  userId: string | null;
  userType: string | null;
  expiresAt: string | null;
  expiresAtMs: number | null;
  isQuotaExceeded: boolean | null;
  totalUsagePercentage: number | null;
  quota: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    percentage: number | null;
    unit: string | null;
  };
  source: "qoder-cli-log";
  logPath?: string;
  capturedAt?: string;
  capturedAtMs?: number | null;
};

export type QoderUsageFreshness = "fresh" | "stale" | "uncertain";

export type QoderUsageProbeResult = {
  ok: boolean;
  provider: "qoder";
  usage?: (QoderQuotaUsage & { logPath: string });
  limitations?: string[];
  freshness?: QoderUsageFreshness;
  ageSeconds?: number | null;
  staleThresholdSeconds?: number;
  scannedLogCount?: number;
  reason?: string;
  error?: string;
};

const QUOTA_RESPONSE_MARKER = "/api/v2/quota/usage response:";

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

function normalizeQuotaPayload(payload: any): QoderQuotaUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const quota = payload.userQuota && typeof payload.userQuota === "object"
    ? payload.userQuota
    : {};
  const expiresAtMs = asFiniteNumber(payload.expiresAt);
  return {
    userId: asString(payload.userId),
    userType: asString(payload.userType),
    expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null,
    expiresAtMs,
    isQuotaExceeded: asBoolean(payload.isQuotaExceeded),
    totalUsagePercentage: asFiniteNumber(payload.totalUsagePercentage),
    quota: {
      total: asFiniteNumber(quota.total),
      used: asFiniteNumber(quota.used),
      remaining: asFiniteNumber(quota.remaining),
      percentage: asFiniteNumber(quota.percentage),
      unit: asString(quota.unit),
    },
    source: "qoder-cli-log",
  };
}

function isRealQuotaResponseLine(line: string): boolean {
  const markerIndex = line.indexOf(QUOTA_RESPONSE_MARKER);
  if (markerIndex < 0) return false;
  const before = line.slice(0, markerIndex);
  if (!before.includes("[qoderApi]")) return false;
  const jsonStart = markerIndex + QUOTA_RESPONSE_MARKER.length;
  const after = line.slice(jsonStart).trimStart();
  return after.startsWith("{");
}

export function parseQoderQuotaUsageFromText(text: string): QoderQuotaUsage | null {
  let latest: QoderQuotaUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!isRealQuotaResponseLine(line)) continue;
    const markerIndex = line.indexOf(QUOTA_RESPONSE_MARKER);
    const jsonText = line.slice(markerIndex + QUOTA_RESPONSE_MARKER.length).trim();
    try {
      const parsed = normalizeQuotaPayload(JSON.parse(jsonText));
      if (parsed) latest = parsed;
    } catch {
      // Ignore malformed historical log lines.
    }
  }
  return latest;
}

export function extractLeadingIsoTimestamp(dirName: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?([+-])(\d{2})-(\d{2})/.exec(dirName);
  if (!match) return null;
  const [, Y, M, D, h, m, s, ms, sign, offH, offM] = match;
  const local = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(m), Number(s), Number(ms ?? 0));
  const offsetMs = (Number(offH) * 60 + Number(offM)) * 60_000;
  const utcMs = sign === "+" ? local - offsetMs : local + offsetMs;
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

type RunLogEntry = {
  logPath: string;
  capturedAtMs: number | null;
  capturedAt: string | null;
  dirName: string;
};

function listQoderRunLogs(qoderHome: string): RunLogEntry[] {
  const runsDir = join(qoderHome, "logs", "runs");
  if (!existsSync(runsDir)) return [];
  const entries: RunLogEntry[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const logPath = join(runsDir, entry.name, "qodercli.log");
    if (!existsSync(logPath)) continue;
    const capturedAt = extractLeadingIsoTimestamp(entry.name);
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : null;
    entries.push({
      logPath,
      capturedAtMs,
      capturedAt,
      dirName: entry.name,
    });
  }
  entries.sort((a, b) => {
    const aMs = a.capturedAtMs ?? statSync(a.logPath).mtimeMs;
    const bMs = b.capturedAtMs ?? statSync(b.logPath).mtimeMs;
    return bMs - aMs;
  });
  return entries;
}

export function findLatestQoderQuotaUsage(options: {
  qoderHome?: string;
  now?: number;
} = {}): (QoderQuotaUsage & { logPath: string; capturedAtMs: number | null; capturedAt: string | null }) | null {
  const qoderHome = options.qoderHome || join(homedir(), ".qoder");
  for (const run of listQoderRunLogs(qoderHome)) {
    const parsed = parseQoderQuotaUsageFromText(readFileSync(run.logPath, "utf8"));
    if (!parsed) continue;
    return {
      ...parsed,
      logPath: run.logPath,
      capturedAt: run.capturedAt,
      capturedAtMs: run.capturedAtMs,
    };
  }
  return null;
}

const DEFAULT_STALE_THRESHOLD_SECONDS = 6 * 60 * 60;

export function classifyQoderUsageFreshness(
  usage: { capturedAtMs: number | null } | null,
  options: { now?: number; staleThresholdSeconds?: number } = {},
): QoderUsageFreshness {
  if (!usage || usage.capturedAtMs == null) return "uncertain";
  const now = options.now ?? Date.now();
  const threshold = (options.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS) * 1000;
  const age = now - usage.capturedAtMs;
  if (!Number.isFinite(age) || age < 0) return "uncertain";
  return age > threshold ? "stale" : "fresh";
}

function readOption(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runQoderUsageCommand(
  args: string[],
  deps: {
    env?: Record<string, string | undefined>;
    output?: { write(chunk: string): unknown };
    now?: () => number;
  } = {},
) {
  const output = deps.output ?? process.stdout;
  const agent = args[0]?.trim();
  if (!agent || agent === "--help" || agent === "-h") {
    output.write("Usage: nolo agent usage qoder [--qoder-home <path>] [--stale-threshold-seconds <n>]\n");
    return agent ? 0 : 1;
  }
  if (agent.toLowerCase() !== "qoder") {
    output.write(`[nolo] agent usage currently supports qoder only, received ${agent}.\n`);
    return 1;
  }
  const qoderHome =
    readOption(args, "--qoder-home") ||
    deps.env?.QODER_HOME ||
    join(homedir(), ".qoder");
  const now = deps.now ? deps.now() : Date.now();
  const thresholdArg = readOption(args, "--stale-threshold-seconds");
  const staleThresholdSeconds = thresholdArg ? Number(thresholdArg) : DEFAULT_STALE_THRESHOLD_SECONDS;
  const usage = findLatestQoderQuotaUsage({ qoderHome, now });
  const freshness = classifyQoderUsageFreshness(usage, { now, staleThresholdSeconds });
  const ageSeconds = usage?.capturedAtMs != null ? Math.max(0, Math.floor((now - usage.capturedAtMs) / 1000)) : null;

  if (!usage) {
    const result: QoderUsageProbeResult = {
      ok: false,
      provider: "qoder",
      freshness,
      ageSeconds,
      staleThresholdSeconds,
      limitations: [
        "This probe only reads Qoder package Credits from local quota logs.",
        "It does not currently read the Qwen3.7-Max daily free request quota; check Qoder's Usage Overview or CLI /usage for that counter.",
      ],
      error:
        "No Qoder quota usage log found. Open `qoder`, run `/usage`, then retry this command.",
      reason:
        "Probe could not locate any real [qoderApi] quota response line in local run logs.",
    };
    output.write(JSON.stringify(result, null, 2));
    output.write("\n");
    return 1;
  }

  const result: QoderUsageProbeResult = {
    ok: true,
    provider: "qoder",
    usage,
    limitations: [
      "This is package Credits usage only, parsed from Qoder's /api/v2/quota/usage log.",
      "Qwen3.7-Max daily free requests are a separate counter and are not exposed in this probe's current log source.",
    ],
    freshness,
    ageSeconds,
    staleThresholdSeconds,
  };
  if (freshness !== "fresh") {
    result.reason =
      freshness === "stale"
        ? `Latest local quota log is ${ageSeconds}s old (threshold ${staleThresholdSeconds}s); UI or server may show a different value.`
        : "Latest local quota log has no reliable capture timestamp; treat numbers as uncertain.";
  }
  output.write(JSON.stringify(result, null, 2));
  output.write("\n");
  return freshness === "fresh" ? 0 : 2;
}
