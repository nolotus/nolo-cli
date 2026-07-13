import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local inventory of provider *sources* (subscription / API / CLI).
 * Records never store secrets — only optional credentialRef pointing into the broker.
 */

export type SourceKind = "subscription" | "api" | "cli";
export type SourceStatus = "ready" | "pending" | "missing-credential" | "error";

export type SourceRecord = {
  sourceId: string;
  kind: SourceKind;
  providerId: string;
  label: string;
  /** Opaque broker ref; never a raw secret. */
  credentialRef?: string;
  status: SourceStatus;
  updatedAt: number;
};

export type SourceRegistry = {
  list(): SourceRecord[];
  get(sourceId: string): SourceRecord | null;
  upsert(record: Omit<SourceRecord, "updatedAt"> & { updatedAt?: number }): SourceRecord;
  remove(sourceId: string): boolean;
};

type SourceRegistryFile = {
  version: 1;
  sources: SourceRecord[];
};

const SOURCE_KINDS = new Set<SourceKind>(["subscription", "api", "cli"]);
const SOURCE_STATUSES = new Set<SourceStatus>([
  "ready",
  "pending",
  "missing-credential",
  "error",
]);

export function getSourceRegistryDir(homeDir = homedir()): string {
  return join(homeDir, ".nolo", "sources");
}

export function getSourceRegistryPath(homeDir = homedir()): string {
  return join(getSourceRegistryDir(homeDir), "registry.json");
}

function assertSourceId(sourceId: string): string {
  const trimmed = typeof sourceId === "string" ? sourceId.trim() : "";
  if (!trimmed) throw new Error("sourceId must be a non-empty string.");
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`sourceId contains forbidden path characters: ${trimmed}`);
  }
  return trimmed;
}

function normalizeSourceRecord(
  input: Partial<SourceRecord> & Pick<SourceRecord, "sourceId" | "kind" | "providerId" | "label" | "status">,
  updatedAt: number,
): SourceRecord {
  const sourceId = assertSourceId(input.sourceId);
  if (!SOURCE_KINDS.has(input.kind)) {
    throw new Error(`Invalid source kind: ${String(input.kind)}`);
  }
  if (!SOURCE_STATUSES.has(input.status)) {
    throw new Error(`Invalid source status: ${String(input.status)}`);
  }
  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!providerId) throw new Error("providerId must be a non-empty string.");
  if (!label) throw new Error("label must be a non-empty string.");

  const credentialRef =
    typeof input.credentialRef === "string" && input.credentialRef.trim()
      ? input.credentialRef.trim()
      : undefined;

  // Guard: never persist values that look like raw API key *secrets* in registry rows.
  // Allow broker refs such as `api-key:agent-foo` (colon-separated id).
  if (credentialRef && /^(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{24,})$/.test(credentialRef)) {
    throw new Error("credentialRef must not look like a raw API key secret.");
  }

  return {
    sourceId,
    kind: input.kind,
    providerId,
    label,
    ...(credentialRef ? { credentialRef } : {}),
    status: input.status,
    updatedAt,
  };
}

function readRegistryFile(path: string): SourceRegistryFile {
  if (!existsSync(path)) {
    return { version: 1, sources: [] };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SourceRegistryFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.sources)) {
      return { version: 1, sources: [] };
    }
    return {
      version: 1,
      sources: parsed.sources.filter(
        (row): row is SourceRecord =>
          !!row &&
          typeof row === "object" &&
          typeof row.sourceId === "string" &&
          typeof row.providerId === "string" &&
          typeof row.label === "string",
      ),
    };
  } catch {
    return { version: 1, sources: [] };
  }
}

function writeRegistryFile(path: string, file: SourceRegistryFile, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

export type CreateFileSourceRegistryOptions = {
  homeDir?: string;
  now?: () => number;
};

export function createFileSourceRegistry(
  options: CreateFileSourceRegistryOptions = {},
): SourceRegistry {
  const homeDir = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  const path = getSourceRegistryPath(homeDir);
  const dir = getSourceRegistryDir(homeDir);

  return {
    list() {
      return [...readRegistryFile(path).sources].sort((a, b) =>
        a.sourceId.localeCompare(b.sourceId),
      );
    },
    get(sourceId) {
      const id = assertSourceId(sourceId);
      return readRegistryFile(path).sources.find((row) => row.sourceId === id) ?? null;
    },
    upsert(record) {
      const next = normalizeSourceRecord(record, record.updatedAt ?? now());
      const file = readRegistryFile(path);
      const idx = file.sources.findIndex((row) => row.sourceId === next.sourceId);
      if (idx >= 0) {
        file.sources[idx] = next;
      } else {
        file.sources.push(next);
      }
      writeRegistryFile(path, file, dir);
      return next;
    },
    remove(sourceId) {
      const id = assertSourceId(sourceId);
      const file = readRegistryFile(path);
      const before = file.sources.length;
      file.sources = file.sources.filter((row) => row.sourceId !== id);
      if (file.sources.length === before) return false;
      writeRegistryFile(path, file, dir);
      return true;
    },
  };
}
