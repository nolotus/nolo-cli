import type { AgentCommandDeps } from "./agentCommandSupport";
import {
  readOption,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "./cliEnvHelpers";

const VALUE_FLAGS = new Set([
  "--facet",
  "--id",
  "--ids",
  "--kind",
  "--limit",
  "--pattern-prefix",
  "--server",
  "--server-url",
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
    if (typeof value === "string" && value.trim()) values.push(value.trim());
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
  fetchImpl: typeof fetch;
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
          error: error instanceof Error ? error.message : String(error),
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
    output.write(`[nolo] memory delete failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
