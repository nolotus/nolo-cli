import { toErrorMessage } from "./core/errorMessage";
import { resolveAgentRuntimeDecision } from "./agent-runtime/runtimeDecision";
import {
  resolveCliAuthorityBrokerEndpoint,
  resolveCliAuthorityBrokerHealthPath,
  resolveCliAuthorityBrokerMetadataPath,
  resolveCliAuthorityStoreDriver,
} from "./database/server/cliAuthorityStoreDriver";
import {
  type AgentCommandDeps,
  type LocalRuntimeProbeResult,
} from "./agentCommandSupport";
import {
  resolveAuthToken,
  resolveServerUrl,
  type EnvLike,
} from "./cliEnvHelpers";
import { probeCliAuthorityBrokerHealth } from "./cliAuthorityBrokerHealth";

function detectLocalAgentConfig(env: EnvLike) {
  return Boolean(readLocalAgentKey(env) || env.NOLO_AGENT_CACHE_READY);
}

function readLocalAgentKey(env: EnvLike) {
  return env.NOLO_LOCAL_AGENT_KEY || env.NOLO_AGENT || "";
}

function detectLocalProvider(env: EnvLike) {
  return Boolean(
    env.OPENAI_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.GOOGLE_API_KEY ||
    env.GEMINI_API_KEY ||
    env.NOLO_LOCAL_OPENAI_BASE_URL ||
    env.OLLAMA_BASE_URL
  );
}

function detectProviderLabel(env: EnvLike) {
  if (env.NOLO_LOCAL_OPENAI_BASE_URL) return `openai-compatible endpoint ${env.NOLO_LOCAL_OPENAI_BASE_URL}`;
  if (env.OLLAMA_BASE_URL) return `ollama-compatible endpoint ${env.OLLAMA_BASE_URL}`;
  if (env.OPENAI_API_KEY) return "openai via env OPENAI_API_KEY";
  if (env.ANTHROPIC_API_KEY) return "anthropic via env ANTHROPIC_API_KEY";
  if (env.GOOGLE_API_KEY) return "google via env GOOGLE_API_KEY";
  if (env.GEMINI_API_KEY) return "google via env GEMINI_API_KEY";
  return "missing";
}

type DefaultLocalRuntimeProbeDeps = {
  getDb?: () => Promise<{ get(key: string): Promise<unknown> }>;
  probeAuthorityHealth?: typeof probeCliAuthorityBrokerHealth;
};

export async function defaultLocalRuntimeProbe(
  env: EnvLike,
  deps: DefaultLocalRuntimeProbeDeps = {}
): Promise<LocalRuntimeProbeResult> {
  const { resolveCliLocalRuntimeDbPath } = await import("./localRuntimeDb");
  const dbPath = resolveCliLocalRuntimeDbPath({ env });
  const authorityDriver = resolveCliAuthorityStoreDriver({ env });
  const authorityEndpoint = resolveCliAuthorityBrokerEndpoint({ transport: "tcp", env });
  const authorityMetadataPath = resolveCliAuthorityBrokerMetadataPath({ transport: "tcp", env });
  const authorityHealthPath = resolveCliAuthorityBrokerHealthPath({ transport: "tcp", env });
  const agentKey = readLocalAgentKey(env);
  try {
    const db = deps.getDb
      ? await deps.getDb()
      : await import("./localRuntimeDb").then(({ getDefaultCliLocalRuntimeDb }) =>
          getDefaultCliLocalRuntimeDb({ env })
        );
    const authorityHealth = await (
      deps.probeAuthorityHealth ?? probeCliAuthorityBrokerHealth
    )({
      endpoint: authorityEndpoint,
      metadataPath: authorityMetadataPath,
      healthPath: authorityHealthPath,
    });
    if (!authorityHealth.ok) {
      return {
        ok: true,
        dbPath,
        authorityDriver,
        authorityEndpoint,
        authorityMetadataPath,
        authorityHealthPath,
        authorityHealthy: false,
        authorityError: authorityHealth.error,
        agentFound: false,
        ...(agentKey ? { agentKey } : {}),
      };
    }
    if (!agentKey) {
      return {
        ok: true,
        dbPath,
        authorityDriver,
        authorityEndpoint,
        authorityMetadataPath,
        authorityHealthPath,
        authorityHealthy: true,
        agentFound: false,
      };
    }
    try {
      const record = await db.get(agentKey);
      return {
        ok: true,
        dbPath,
        authorityDriver,
        authorityEndpoint,
        authorityMetadataPath,
        authorityHealthPath,
        authorityHealthy: true,
        agentFound: record != null,
        agentKey,
      };
    } catch {
      return {
        ok: true,
        dbPath,
        authorityDriver,
        authorityEndpoint,
        authorityMetadataPath,
        authorityHealthPath,
        authorityHealthy: true,
        agentFound: false,
        agentKey,
      };
    }
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    return {
      ok: false,
      dbPath,
      authorityDriver,
      authorityEndpoint,
      authorityMetadataPath,
      authorityHealthPath,
      authorityHealthy: false,
      authorityError: errorMessage,
      agentFound: false,
      ...(agentKey ? { agentKey } : {}),
      error: errorMessage,
    };
  }
}

export async function runDoctorRuntimeCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const authToken = resolveAuthToken(args, env);
  const serverUrl = resolveServerUrl(args, env);
  const localProbe = await (deps.localRuntimeProbe ?? defaultLocalRuntimeProbe)(env);
  const hasLocalAgentConfig = detectLocalAgentConfig(env) && localProbe.ok && localProbe.agentFound;
  const hasLocalProvider = detectLocalProvider(env);
  const missingLocalCapabilities = [
    ...(localProbe.ok ? [] : ["leveldb"]),
    ...(localProbe.authorityHealthy === false ? ["authority-broker"] : []),
    ...(hasLocalAgentConfig ? [] : ["agent-config"]),
    ...(hasLocalProvider ? [] : ["provider"]),
  ];
  const decision = resolveAgentRuntimeDecision({
    requestedMode: "auto",
    syncRequested: false,
    host: "cli",
    hasLocalAgentConfig,
    hasLocalProvider,
    hasLocalPersistence: true,
    missingLocalCapabilities,
    requiresServer: false,
    serverFallbackAvailable: Boolean(
      authToken ||
      args.includes("--server") ||
      args.includes("--server-url") ||
      env.NOLO_SERVER ||
      env.BASE_URL
    ),
  });

  output.write(`Runtime: ${decision.mode}\n`);
  output.write(`Reason: ${decision.reason}\n`);
  output.write(`LevelDB: ${localProbe.ok ? "ok" : "failed"}\n`);
  output.write(`DB path: ${localProbe.dbPath}\n`);
  output.write(`Authority driver: ${localProbe.authorityDriver ?? "unknown"}\n`);
  if (localProbe.authorityEndpoint) {
    output.write(`Authority endpoint: ${localProbe.authorityEndpoint}\n`);
  }
  if (localProbe.authorityMetadataPath) {
    output.write(`Authority metadata: ${localProbe.authorityMetadataPath}\n`);
  }
  if (localProbe.authorityHealthPath) {
    output.write(`Authority health: ${localProbe.authorityHealthPath}\n`);
  }
  output.write(
    `Authority broker: ${
      localProbe.authorityHealthy === true
        ? "healthy"
        : localProbe.authorityHealthy === false
          ? "unhealthy"
          : "unknown"
    }\n`
  );
  if (localProbe.authorityHealthy === false && localProbe.authorityError) {
    output.write(`Authority error: ${localProbe.authorityError}\n`);
  }
  if (!localProbe.ok && localProbe.error) {
    output.write(`DB error: ${localProbe.error}\n`);
  }
  if (localProbe.agentKey) {
    output.write(`Agent config: ${localProbe.agentFound ? "found" : "missing"} (${localProbe.agentKey})\n`);
  } else {
    output.write("Agent config: missing (no local agent key)\n");
  }
  output.write(`Provider: ${hasLocalProvider ? "available" : "missing"} (${detectProviderLabel(env)})\n`);
  output.write("Persistence: LevelDB local store\n");
  output.write(`Sync: ${authToken ? "available" : "unavailable"}${authToken ? "" : " (not authenticated)"}\n`);
  output.write(`Server fallback: ${decision.runnable && decision.mode === "server" ? serverUrl : authToken || env.NOLO_SERVER || env.BASE_URL ? serverUrl : "unavailable"}\n`);
  if (decision.missingLocalCapabilities.length > 0) {
    output.write("Missing local capabilities:\n");
    for (const capability of decision.missingLocalCapabilities) {
      output.write(`- ${capability}\n`);
    }
  }

  return decision.runnable ? 0 : 1;
}
