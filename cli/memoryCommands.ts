import { toErrorMessage } from "../core/errorMessage";
import { asOptionalTrimmedString } from "../core/optionalString";
import type { AgentCommandDeps } from "./agentCommandSupport";
import type { CliFetchImpl } from "./cliFetch";
import {
  readOption,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "./cliEnvHelpers";

const VALUE_FLAGS = new Set([
  "--content",
  "--cursor",
  "--dialog-id",
  "--facet",
  "--id",
  "--ids",
  "--kind",
  "--limit",
  "--pattern-prefix",
 "--scope",
  "--server",
  "--server-url",
  "--space",
  "--source-dialog",
  "--subject",
  "--subject-id",
  "--subject-type",
  "--tag",
  "--token",
]);

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function printMemoryDeleteUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo memory delete --source-dialog <dialogId> --yes [--json]
  nolo memory delete --tag <tag> --kind <kind> --yes
  nolo memory delete --pattern-prefix <prefix> --limit <n> --yes

Options:
  --id <memoryId>            Delete a specific memory id. Repeatable.
  --ids <a,b,c>              Delete specific memory ids.
  --source-dialog <dialogId> Delete memories created from one dialog.
  --tag <tag>                Require a tag. Repeatable.
  --kind <kind>              Filter episodic / semantic / procedural. Repeatable.
  --facet <facet>            Filter preference / tension / unfinished / goal / style. Repeatable.
  --subject-type <type>      Filter user / agent / space / project / system.
  --subject <subjectId>      Filter subjectId.
  --pattern-prefix <prefix>  Filter patternKey prefix.
  --limit <n>                Maximum memories to delete.
  --yes                      Actually delete. Without this, command is a dry-run.
  --json                     Print machine-readable JSON.
  --server <url>             Prefer this server and include known Nolo peers.
  --token <jwt>              Override AUTH_TOKEN.

At least one filter is required; this command will not delete all memory implicitly.
`);
}

function readRepeated(args: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    const trimmed = asOptionalTrimmedString(value);
    if (trimmed) values.push(trimmed);
  }
  return values;
}

function readCsvValues(args: string[], flag: string) {
  const raw = readRepeated(args, flag).join(",");
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readLimit(args: string[]) {
  const raw = readOption(args, "--limit");
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`invalid --limit: ${raw}`);
  const parsed = Number(raw);
  return parsed > 0 ? parsed : undefined;
}

function assertNoUnknownFlags(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("-")) continue;
    if (value === "--help" || value === "-h" || value === "--yes" || value === "--json") continue;
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${value}`);
  }
}

function buildDeleteBody(args: string[]) {
  const ids = [...readRepeated(args, "--id"), ...readCsvValues(args, "--ids")];
  const kinds = readRepeated(args, "--kind");
  const facets = readRepeated(args, "--facet");
  const tags = readRepeated(args, "--tag");
  const sourceDialogId = readOption(args, "--source-dialog")?.trim();
  const subjectType = readOption(args, "--subject-type")?.trim();
  const subjectId = (readOption(args, "--subject") ?? readOption(args, "--subject-id"))?.trim();
  const patternKeyPrefix = readOption(args, "--pattern-prefix")?.trim();
  const limit = readLimit(args);

  const body: Record<string, unknown> = {};
  if (ids.length) body.ids = [...new Set(ids)];
  if (kinds.length) body.kinds = [...new Set(kinds)];
  if (facets.length) body.facets = [...new Set(facets)];
  if (tags.length) body.tags = [...new Set(tags)];
  if (sourceDialogId) body.sourceDialogId = sourceDialogId;
  if (subjectType) body.subjectType = subjectType;
  if (subjectId) body.subjectId = subjectId;
  if (patternKeyPrefix) body.patternKeyPrefix = patternKeyPrefix;
  if (typeof limit === "number") body.limit = limit;
  return body;
}

function hasDeleteFilter(body: Record<string, unknown>) {
  return Object.keys(body).some((key) => key !== "limit");
}

async function postMemoryDelete(args: {
  authToken: string;
  body: Record<string, unknown>;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
}) {
  const res = await args.fetchImpl(`${args.serverUrl}/api/memory/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.body),
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok || payload?.error) {
    const message =
      payload?.error?.message ??
      payload?.message ??
      payload?.error ??
      `HTTP ${res.status}`;
    throw new Error(`${message}`);
  }
  return payload;
}

export async function runMemoryDeleteCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printMemoryDeleteUsage(output);
    return 0;
  }

  try {
    assertNoUnknownFlags(args);
    const authToken = resolveAuthToken(args, env);
    if (!authToken) {
      output.write("[nolo] memory delete requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
      return 1;
    }

    const body = buildDeleteBody(args);
    if (!hasDeleteFilter(body)) {
      output.write("[nolo] memory delete requires at least one filter; use --help for examples.\n");
      return 1;
    }

    const shouldDelete = hasFlag(args, "--yes");
    const wantJson = hasFlag(args, "--json");
    const fetchImpl = deps.fetchImpl ?? fetch;
    const serverUrl = resolveServerUrl(args, env);
    const serverUrls = resolveServerCandidates(args, env, serverUrl);

    if (!shouldDelete) {
      const payload = {
        dryRun: true,
        deleted: false,
        targetServers: serverUrls,
        request: body,
        nextStep: "rerun with --yes to delete matching memories",
      };
      if (wantJson) {
        output.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        output.write("dryRun: true\n");
        output.write(`targetServers: ${serverUrls.join(", ")}\n`);
        output.write(`request: ${JSON.stringify(body)}\n`);
        output.write("rerun with --yes to delete matching memories\n");
      }
      return 0;
    }

    const promises = serverUrls.map(async (target) => {
      try {
        const result = await postMemoryDelete({
          authToken,
          body,
          fetchImpl,
          serverUrl: target,
        });
        return { serverUrl: target, ok: true, result };
      } catch (error) {
        return {
          serverUrl: target,
          ok: false,
          error: toErrorMessage(error),
        };
      }
    });
    const deleteResults = await Promise.all(promises);

    const deletedCount = deleteResults.reduce(
      (sum, item) => sum + (item.ok ? Number(item.result?.deletedCount ?? 0) : 0),
      0
    );
    const payload = {
      dryRun: false,
      deleted: true,
      deletedCount,
      request: body,
      targetServers: serverUrls,
      deleteResults,
    };
    if (wantJson) {
      output.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      output.write(`deletedCount: ${deletedCount}\n`);
      for (const result of deleteResults) {
        output.write(
          result.ok
            ? `${result.serverUrl}: ok deleted=${result.result?.deletedCount ?? 0}\n`
            : `${result.serverUrl}: failed ${result.error}\n`
        );
      }
    }
    return deleteResults.some((result) => result.ok) ? 0 : 1;
  } catch (error) {
    output.write(`[nolo] memory delete failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}

function printMemoryListUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo memory list [--limit 50] [--kind episodic] [--subject-type agent]
  nolo memory list --subject-type agent --subject <subjectId> --json

Options:
  --limit <n>               Page size (1-200, default 50).
  --cursor <cursor>         Continue from a previous page's nextCursor.
  --kind <kind>             Filter episodic / semantic / procedural.
  --subject-type <type>     Filter user / agent / space / project / system.
  --subject <subjectId>    Filter subjectId (requires --subject-type).
  --json                    Print machine-readable JSON.
  --server <url>            Prefer this server and include known Nolo peers.
  --token <jwt>             Override AUTH_TOKEN.

Listing is scoped to the authenticated user's memories.
`);
}

function buildListBody(args: string[]) {
  const body: Record<string, unknown> = {};
  const limit = readLimit(args);
  if (typeof limit === "number") body.limit = limit;
  const cursor = readOption(args, "--cursor")?.trim();
  if (cursor) body.cursor = cursor;
  const kind = readOption(args, "--kind")?.trim();
  if (kind) body.kind = kind;
  const subjectType = readOption(args, "--subject-type")?.trim();
  if (subjectType) body.subjectType = subjectType;
  const subjectId = (readOption(args, "--subject") ?? readOption(args, "--subject-id"))?.trim();
  if (subjectId) body.subjectId = subjectId;
  return body;
}

/**
 * Parse a memory API response body. Returns the decoded JSON object (typed
 * loosely) plus an errorMessage pulled from { error.message } / { message }
 * when present. Non-JSON bodies become { raw } with no error message.
 */
function parseMemoryResponse(text: string): {
  result: Record<string, unknown> | null;
  errorMessage: string | undefined;
} {
  if (!text) return { result: null, errorMessage: undefined };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = (parsed as { error?: { message?: string }; message?: string }).error;
      const message = typeof err === "object" && err !== null && "message" in err
        ? String((err as { message?: unknown }).message ?? "")
        : "";
      return { result: parsed, errorMessage: message || (parsed as { message?: string }).message };
    }
    return { result: parsed, errorMessage: undefined };
  } catch {
    return { result: { raw: text }, errorMessage: undefined };
  }
}

async function postMemoryList(args: {
  authToken: string;
  body: Record<string, unknown>;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
}) {
  const res = await args.fetchImpl(`${args.serverUrl}/api/memory/list`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.body),
  });
  const text = await res.text();
  const parsed = parseMemoryResponse(text);
  if (!res.ok) {
    throw new Error(parsed.errorMessage ?? `HTTP ${res.status}`);
  }
  if (parsed.errorMessage) {
    throw new Error(parsed.errorMessage);
  }
  return parsed.result as { items?: unknown[]; nextCursor?: string; truncated?: boolean };
}

function renderMemoryItem(item: unknown): string {
  if (typeof item !== "object" || item === null) return String(item);
  const record = item as {
    id?: string;
    kind?: string;
    subjectType?: string;
    subjectId?: string;
    content?: string;
    scope?: string;
    patternKey?: string;
    createdAt?: string;
  };
  const parts: string[] = [];
  if (record.id) parts.push(record.id);
  if (record.kind) parts.push(`kind=${record.kind}`);
  if (record.subjectType) parts.push(`subject=${record.subjectType}${record.subjectId ? `:${record.subjectId}` : ""}`);
  if (record.scope) parts.push(`scope=${record.scope}`);
  const content = record.content ? (record.content.length > 80 ? `${record.content.slice(0, 80)}…` : record.content) : "";
  return [parts.join("  "), content].filter(Boolean).join("\n    ");
}

export async function runMemoryListCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printMemoryListUsage(output);
    return 0;
  }

  try {
    assertNoUnknownFlags(args);
    const authToken = resolveAuthToken(args, env);
    if (!authToken) {
      output.write("[nolo] memory list requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
      return 1;
    }

    const body = buildListBody(args);
    const wantJson = hasFlag(args, "--json");
    const fetchImpl = deps.fetchImpl ?? fetch;
    const serverUrl = resolveServerUrl(args, env);
    const serverUrls = resolveServerCandidates(args, env, serverUrl);

    const target = serverUrls[0] ?? serverUrl;
    try {
      const result = await postMemoryList({ authToken, body, fetchImpl, serverUrl: target });
      const items = Array.isArray(result.items) ? result.items : [];
      if (wantJson) {
        output.write(`${JSON.stringify({ items, nextCursor: result.nextCursor, truncated: result.truncated }, null, 2)}\n`);
      } else {
        output.write(`${target}: ${items.length} memor${items.length === 1 ? "y" : "ies"}\n`);
        for (const item of items) {
          output.write(`  ${renderMemoryItem(item)}\n`);
        }
        if (result.nextCursor) {
          output.write(`nextCursor: ${result.nextCursor}\n`);
        }
        if (result.truncated) {
          output.write("truncated: true (more entries may exist; page with --cursor)\n");
        }
      }
      return 0;
    } catch (error) {
      output.write(`[nolo] memory list failed: ${toErrorMessage(error)}\n`);
      return 1;
    }
  } catch (error) {
    output.write(`[nolo] memory list failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}

function printMemoryRememberUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo memory remember --content "用户偏好先看结论" --kind semantic
  nolo memory remember --content "..." --kind episodic --scope auto --dialog-id <id>

Options:
  --content <text>         The memory text to store (required).
  --kind <kind>            episodic / semantic / procedural (required).
  --scope <scope>          auto / user / space (default auto).
  --dialog-id <id>         Attach to a dialog.
  --space <spaceId>        Store under a space (requires space membership).
  --json                    Print machine-readable JSON.
  --server <url>            Prefer this server and include known Nolo peers.
  --token <jwt>             Override AUTH_TOKEN.
`);
}

function buildRememberBody(args: string[]) {
  const content = readOption(args, "--content")?.trim();
  const kind = readOption(args, "--kind")?.trim();
  const scope = readOption(args, "--scope")?.trim();
  const dialogId = readOption(args, "--dialog-id")?.trim();
  const spaceId = readOption(args, "--space")?.trim();
  return { content, kind, scope, dialogId, spaceId };
}

async function postMemoryRemember(args: {
  authToken: string;
  body: Record<string, unknown>;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
}) {
  const res = await args.fetchImpl(`${args.serverUrl}/api/memory/remember`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.body),
  });
  const text = await res.text();
  const parsed = parseMemoryResponse(text);
  if (!res.ok) {
    throw new Error(parsed.errorMessage ?? `HTTP ${res.status}`);
  }
  if (parsed.errorMessage) {
    throw new Error(parsed.errorMessage);
  }
  return parsed.result;
}

const REMEMBER_KINDS = new Set(["episodic", "semantic", "procedural"]);
const REMEMBER_SCOPES = new Set(["auto", "user", "space"]);

export async function runMemoryRememberCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printMemoryRememberUsage(output);
    return 0;
  }

  try {
    assertNoUnknownFlags(args);
    const authToken = resolveAuthToken(args, env);
    if (!authToken) {
      output.write("[nolo] memory remember requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
      return 1;
    }

    const { content, kind, scope, dialogId, spaceId } = buildRememberBody(args);
    if (!content) {
      output.write("[nolo] memory remember requires --content <text>; use --help for examples.\n");
      return 1;
    }
    if (!kind || !REMEMBER_KINDS.has(kind)) {
      output.write("[nolo] memory remember requires --kind <episodic|semantic|procedural>.\n");
      return 1;
    }
    const normalizedScope = scope && REMEMBER_SCOPES.has(scope) ? scope : "auto";

    const body: Record<string, unknown> = { content, kind, scope: normalizedScope };
    if (dialogId) body.dialogId = dialogId;
    if (spaceId) body.spaceId = spaceId;

    const wantJson = hasFlag(args, "--json");
    const fetchImpl = deps.fetchImpl ?? fetch;
    const serverUrl = resolveServerUrl(args, env);
    const serverUrls = resolveServerCandidates(args, env, serverUrl);
    const target = serverUrls[0] ?? serverUrl;

    try {
      const result = await postMemoryRemember({ authToken, body, fetchImpl, serverUrl: target });
      if (wantJson) {
        output.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        output.write(`${target}: remembered ${kind}\n`);
      }
      return 0;
    } catch (error) {
      output.write(`[nolo] memory remember failed: ${toErrorMessage(error)}\n`);
      return 1;
    }
  } catch (error) {
    output.write(`[nolo] memory remember failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}
