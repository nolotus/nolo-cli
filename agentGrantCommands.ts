import { toErrorMessage } from "./core/errorMessage";
import { asOptionalTrimmedString } from "./core/optionalString";
import { resolveCliAgentKeyInput } from "./agentAliases";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerUrl,
  type EnvLike,
} from "./cliEnvHelpers";
import type { CliFetchImpl } from "./cliFetch";

type OutputLike = {
  write(chunk: string): unknown;
};

export type AgentGrantCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  fetchImpl?: CliFetchImpl;
};

function wantsHelp(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

function wantsJson(args: string[]) {
  return args.includes("--json");
}

function positionalArgs(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (arg.includes("=")) continue;
      if (args[index + 1] && !args[index + 1]!.startsWith("--")) index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function writeGrantHelp(output: OutputLike) {
  output.write(
    "Usage:\n" +
      "  nolo agent grant <agent> --to <userId> [--json]\n" +
      "  nolo agent grants <agent> [--json] [--include-revoked]\n" +
      "  nolo agent revoke-grant <agent> --from <userId> [--json]\n" +
      "\n" +
      "Grant lets another user burn this agent's owner OAuth/custom credentials\n" +
      "via the server proxy. Favorite is NOT a grant.\n" +
      "Private agents already share OAuth with same-space members; use grants for\n" +
      "public agents or cross-space people.\n",
  );
}

async function resolveAgentKeyOrFail(args: {
  raw: string | undefined;
  output: OutputLike;
}): Promise<string | null> {
  const raw = asOptionalTrimmedString(args.raw);
  if (!raw) {
    args.output.write("[nolo] agent key is required.\n");
    writeGrantHelp(args.output);
    return null;
  }
  return resolveCliAgentKeyInput(raw);
}

async function callGrantApi(args: {
  method: "GET" | "POST" | "DELETE";
  serverUrl: string;
  authToken: string;
  fetchImpl: CliFetchImpl;
  agentKey: string;
  granteeUserId?: string;
  includeRevoked?: boolean;
}) {
  const url = new URL("/api/agent-grants", args.serverUrl);
  if (args.method === "GET") {
    url.searchParams.set("agentKey", args.agentKey);
    if (args.includeRevoked) url.searchParams.set("includeRevoked", "1");
  }
  const res = await args.fetchImpl(url.toString(), {
    method: args.method,
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      ...(args.method === "GET"
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(args.method === "GET"
      ? {}
      : {
          body: JSON.stringify({
            agentKey: args.agentKey,
            granteeUserId: args.granteeUserId,
          }),
        }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `HTTP ${res.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function runAgentGrantCommand(
  args: string[],
  deps: AgentGrantCommandDeps = {},
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (wantsHelp(args)) {
    writeGrantHelp(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent grant requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }
  if (!parseUserIdFromAuthToken(authToken)) {
    output.write("[nolo] agent grant could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const agentKey = await resolveAgentKeyOrFail({
    raw: positionalArgs(args)[0],
    output,
  });
  if (!agentKey) return 1;

  const granteeUserId =
    asOptionalTrimmedString(readOption(args, "--to")) ||
    asOptionalTrimmedString(readOption(args, "--grantee"));
  if (!granteeUserId) {
    output.write("[nolo] --to <userId> is required.\n");
    writeGrantHelp(output);
    return 1;
  }

  try {
    const body = await callGrantApi({
      method: "POST",
      serverUrl: resolveServerUrl(args, env),
      authToken,
      fetchImpl: deps.fetchImpl ?? fetch,
      agentKey,
      granteeUserId,
    });
    if (wantsJson(args)) {
      output.write(`${JSON.stringify(body, null, 2)}\n`);
    } else {
      output.write(
        `Granted ${agentKey} → ${granteeUserId}` +
          ` (owner ${body?.grant?.ownerUserId ?? "?"})\n`,
      );
    }
    return 0;
  } catch (error) {
    output.write(`[nolo] agent grant failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}

export async function runAgentGrantsListCommand(
  args: string[],
  deps: AgentGrantCommandDeps = {},
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (wantsHelp(args)) {
    writeGrantHelp(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent grants requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const agentKey = await resolveAgentKeyOrFail({
    raw: positionalArgs(args)[0],
    output,
  });
  if (!agentKey) return 1;

  try {
    const body = await callGrantApi({
      method: "GET",
      serverUrl: resolveServerUrl(args, env),
      authToken,
      fetchImpl: deps.fetchImpl ?? fetch,
      agentKey,
      includeRevoked: args.includes("--include-revoked"),
    });
    if (wantsJson(args)) {
      output.write(`${JSON.stringify(body, null, 2)}\n`);
      return 0;
    }
    const grants = Array.isArray(body?.grants) ? body.grants : [];
    if (grants.length === 0) {
      output.write(`No active grants for ${agentKey}.\n`);
      return 0;
    }
    output.write(`Grants for ${agentKey}:\n`);
    for (const grant of grants) {
      output.write(
        `  - ${grant.granteeUserId}` +
          (grant.revokedAt ? ` (revoked ${grant.revokedAt})` : "") +
          `\n`,
      );
    }
    return 0;
  } catch (error) {
    output.write(`[nolo] agent grants failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}

export async function runAgentRevokeGrantCommand(
  args: string[],
  deps: AgentGrantCommandDeps = {},
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (wantsHelp(args)) {
    writeGrantHelp(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent revoke-grant requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const agentKey = await resolveAgentKeyOrFail({
    raw: positionalArgs(args)[0],
    output,
  });
  if (!agentKey) return 1;

  const granteeUserId =
    asOptionalTrimmedString(readOption(args, "--from")) ||
    asOptionalTrimmedString(readOption(args, "--grantee"));
  if (!granteeUserId) {
    output.write("[nolo] --from <userId> is required.\n");
    writeGrantHelp(output);
    return 1;
  }

  try {
    const body = await callGrantApi({
      method: "DELETE",
      serverUrl: resolveServerUrl(args, env),
      authToken,
      fetchImpl: deps.fetchImpl ?? fetch,
      agentKey,
      granteeUserId,
    });
    if (wantsJson(args)) {
      output.write(`${JSON.stringify(body, null, 2)}\n`);
    } else {
      output.write(`Revoked grant ${agentKey} ✕ ${granteeUserId}\n`);
    }
    return 0;
  } catch (error) {
    output.write(`[nolo] agent revoke-grant failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}
