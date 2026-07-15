import { toErrorMessage } from "../core/errorMessage";
import { generateCloudflareEmailRoutingToken } from "./oauth/flows/cloudflare";
import { upsertEnvVariable } from "./oauth/envFile";
import { createOAuthTokenStore } from "./oauth/token-store";
import { runAgentCreateCommand } from "./agentRecordCommands";
import type { AgentCommandDeps, OutputLike } from "./agentCommandSupport";
import { getReadableCliDb } from "./agentCommandSupport";
import {
  postAgentEmailRpc,
  resolveAgentIdForEmailRpc,
} from "./agentEmailRpc";
import { parseUserIdFromAuthToken, resolveAuthToken } from "./cliEnvHelpers";
import { readFlagValue, positionalArgs } from "./agentRunArgs";

const PROVISION_USAGE =
  "Usage: nolo agent email provision <agent> [--purpose <label>] [--local-part <part>] [--domain <domain>] [--provider <name>] [--no-primary] [--cloudflare-oauth]\n";

const BIND_USAGE =
  "Usage: nolo agent email bind <agent> --email <address> [--provider <name>] [--cloudflare-oauth]\n";

function wantsHelp(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Opt-in helper for the `--cloudflare-oauth` flag: when no
 * CLOUDFLARE_EMAIL_ROUTING_API_TOKEN is configured, use a stored Cloudflare
 * OAuth credential to mint a scoped Email Routing token on the fly.
 *
 * NOTE (kept for a future Cloudflare-customer flow, not the current default):
 * Cloudflare's self-managed OAuth (GA 2026-06) is designed so the OAuth access
 * token is used *directly* against the API within its granted scopes — it does
 * not necessarily expose a scope for minting long-lived tokens via
 * POST /user/tokens. So this self-mint path may 403 depending on the account's
 * available OAuth scopes. The reliable default is to provide a manually created
 * API token via CLOUDFLARE_EMAIL_ROUTING_API_TOKEN and omit --cloudflare-oauth.
 * This branch is retained for the eventual "connect your Cloudflare account"
 * (third-party customer) experience once that flow is fully wired.
 */
async function ensureCloudflareEmailRoutingToken(
  args: string[],
  env: NodeJS.ProcessEnv,
  output: OutputLike
): Promise<{ token: string; wasGenerated: boolean } | null> {
  const existing = env.CLOUDFLARE_EMAIL_ROUTING_API_TOKEN?.trim();
  if (existing) {
    return { token: existing, wasGenerated: false };
  }

  if (!args.includes("--cloudflare-oauth")) {
    return null;
  }

  const credential = createOAuthTokenStore().read("cloudflare");
  if (!credential) {
    throw new Error(
      "No Cloudflare OAuth credential. Run: nolo auth cloudflare --client-id <id>"
    );
  }

  const zoneName = env.CLOUDFLARE_ZONE_NAME?.trim() ?? "nolo.chat";
  const tokenName = `nolo-email-routing-${zoneName}`;
  const { token } = await generateCloudflareEmailRoutingToken({
    accessToken: credential.accessToken,
    zoneName,
    tokenName,
  });

  upsertEnvVariable(".env", "CLOUDFLARE_EMAIL_ROUTING_API_TOKEN", token);
  output.write(
    "[nolo] Generated CLOUDFLARE_EMAIL_ROUTING_API_TOKEN and updated .env.\n"
  );
  output.write(
    "[nolo] If your server is already running, restart it so the new token takes effect.\n"
  );

  return { token, wasGenerated: true };
}

function resolveAgentInput(args: string[]) {
  return readFlagValue(args, "--agent") ?? positionalArgs(args)[0]?.trim();
}

export async function runAgentEmailProvisionCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;

  if (wantsHelp(args) || args.length === 0) {
    output.write(PROVISION_USAGE);
    return args.length === 0 ? 1 : 0;
  }

  const agentInput = resolveAgentInput(args);
  if (!agentInput) {
    output.write(PROVISION_USAGE);
    return 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write(
      "[nolo] agent email provision requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n"
    );
    return 1;
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write(
      "[nolo] agent email provision could not read userId from AUTH_TOKEN.\n"
    );
    return 1;
  }

  const purpose = readFlagValue(args, "--purpose");
  const localPart = readFlagValue(args, "--local-part");
  const domain = readFlagValue(args, "--domain");
  const provider = readFlagValue(args, "--provider");
  const makePrimary = !args.includes("--no-primary");

  const db = deps.db ?? (await getReadableCliDb(output));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;

  try {
    const tokenResult = await ensureCloudflareEmailRoutingToken(args, env, output);
    if (tokenResult?.wasGenerated) {
      env.CLOUDFLARE_EMAIL_ROUTING_API_TOKEN = tokenResult.token;
    }

    const agentId = await resolveAgentIdForEmailRpc({
      agentInput,
      cliArgs: args,
      env,
      db,
      authToken,
      fetchImpl,
      fallbackFetchImpl,
    });

    const result = await postAgentEmailRpc({
      method: "provisionAgentEmailIdentity",
      body: {
        agentId,
        ...(purpose ? { purpose } : {}),
        ...(localPart ? { localPart } : {}),
        ...(domain ? { domain } : {}),
        ...(provider ? { provider } : {}),
        makePrimary,
      },
      cliArgs: args,
      env,
      authToken,
      fetchImpl,
      fallbackFetchImpl,
    });

    await db.put(agentId, {
      ...result.agent,
      dbKey: agentId,
      key: agentId,
      serverOrigin: result.baseUrl,
      cachedAt: Date.now(),
    });

    output.write(
      JSON.stringify(
        {
          ok: true,
          action: "provision",
          agentId: result.data.agentId,
          emailAddress: result.data.emailAddress,
          localPart: result.data.localPart,
          domain: result.data.domain,
          provider: result.data.provider,
          purpose: result.data.purpose,
          readinessStatus: result.data.readinessStatus,
          baseUrl: result.baseUrl,
        },
        null,
        2
      )
    );
    output.write("\n");
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent email provision failed: ${toErrorMessage(error)}\n`
    );
    return 1;
  }
}

export async function runAgentEmailBindCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;

  if (wantsHelp(args) || args.length === 0) {
    output.write(BIND_USAGE);
    return args.length === 0 ? 1 : 0;
  }

  const agentInput = resolveAgentInput(args);
  const emailAddress = readFlagValue(args, "--email")?.trim();
  if (!agentInput || !emailAddress) {
    output.write(BIND_USAGE);
    return 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write(
      "[nolo] agent email bind requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n"
    );
    return 1;
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write(
      "[nolo] agent email bind could not read userId from AUTH_TOKEN.\n"
    );
    return 1;
  }

  const provider = readFlagValue(args, "--provider");
  const db = deps.db ?? (await getReadableCliDb(output));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;

  try {
    const tokenResult = await ensureCloudflareEmailRoutingToken(args, env, output);
    if (tokenResult?.wasGenerated) {
      env.CLOUDFLARE_EMAIL_ROUTING_API_TOKEN = tokenResult.token;
    }

    const agentId = await resolveAgentIdForEmailRpc({
      agentInput,
      cliArgs: args,
      env,
      db,
      authToken,
      fetchImpl,
      fallbackFetchImpl,
    });

    const result = await postAgentEmailRpc({
      method: "bindAgentEmailIdentity",
      body: {
        agentId,
        emailAddress,
        ...(provider ? { provider } : {}),
      },
      cliArgs: args,
      env,
      authToken,
      fetchImpl,
      fallbackFetchImpl,
    });

    await db.put(agentId, {
      ...result.agent,
      dbKey: agentId,
      key: agentId,
      serverOrigin: result.baseUrl,
      cachedAt: Date.now(),
    });

    output.write(
      JSON.stringify(
        {
          ok: true,
          action: "bind",
          agentId: result.data.agentId,
          emailAddress: result.data.emailAddress,
          readinessStatus: result.data.readinessStatus,
          baseUrl: result.baseUrl,
        },
        null,
        2
      )
    );
    output.write("\n");
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent email bind failed: ${toErrorMessage(error)}\n`
    );
    return 1;
  }
}

export async function runAgentEmailCreateAndProvisionCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;

  if (wantsHelp(args)) {
    output.write(
      "Usage: nolo agent email create-and-provision <agent-id-or-slug> --name <display name> [--prompt <text>] [--copy-provider-from <agent>] [--purpose <label>] [--local-part <part>] [--domain <domain>] [--provider <name>]\n"
    );
    return 0;
  }

  const agentSlug = resolveAgentInput(args);
  const name = readFlagValue(args, "--name")?.trim();
  if (!agentSlug || !name) {
    output.write(
      "[nolo] agent email create-and-provision requires <agent> and --name.\n"
    );
    output.write(
      "Usage: nolo agent email create-and-provision <agent> --name <display name> [--prompt <text>] [--copy-provider-from <agent>] [--purpose <label>] [--local-part pay]\n"
    );
    return 1;
  }

  const createArgs = [agentSlug, "--name", name];
  const prompt = readFlagValue(args, "--prompt");
  const copyFrom = readFlagValue(args, "--copy-provider-from");
  if (prompt) {
    createArgs.push("--prompt", prompt);
  }
  if (copyFrom) {
    createArgs.push("--copy-provider-from", copyFrom);
  }

  const createExit = await runAgentCreateCommand(createArgs, deps);
  if (createExit !== 0) {
    return createExit;
  }

  const provisionArgs = [agentSlug];
  for (const flag of [
    "--purpose",
    "--local-part",
    "--domain",
    "--provider",
    "--server",
    "--server-url",
    "--token",
    "--machine-key",
  ] as const) {
    const value = readFlagValue(args, flag);
    if (value) {
      provisionArgs.push(flag, value);
    }
  }
  if (args.includes("--no-primary")) {
    provisionArgs.push("--no-primary");
  }

  return runAgentEmailProvisionCommand(provisionArgs, deps);
}