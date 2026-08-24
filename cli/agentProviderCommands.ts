import { toErrorMessage } from "../core/errorMessage";
import type { AgentCommandDeps } from "./agentCommandSupport";
import { readOption } from "./cliEnvHelpers";
import type { CliFetchImpl } from "./cliFetch";

type EnvVars = Record<string, string | undefined>;

type OpenAICompatModel = { id?: string; name?: string; object?: string };

function asEnvVars(env: NodeJS.ProcessEnv | EnvVars): EnvVars {
  return env as EnvVars;
}

function resolveProviderUrl(args: string[], env: EnvVars): string | undefined {
  return (
    readOption(args, "--url") ??
    readOption(args, "--provider-url") ??
    env.CUSTOM_PROVIDER_URL ??
    env.OPENAI_COMPAT_BASE_URL
  );
}

function resolveProviderKey(args: string[], env: EnvVars): string | undefined {
  return (
    readOption(args, "--api-key") ??
    readOption(args, "--provider-api-key") ??
    env.CUSTOM_API_KEY ??
    env.OPENAI_COMPAT_API_KEY ??
    env.OPENROUTER_API_KEY
  );
}

/** Join a base URL with a path, normalizing trailing slashes. */
function joinBase(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function runAgentModelsCommand(
  args: string[],
  deps: AgentCommandDeps = {}
): Promise<number> {
  const env = asEnvVars(deps.env ?? process.env);
  const output = deps.output ?? process.stdout;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const base = resolveProviderUrl(args, env);
  const key = resolveProviderKey(args, env);
  const filter = (readOption(args, "--filter") ?? "").trim().toLowerCase();
  const wantJson = args.includes("--json");

  if (!base) {
    output.write(
      "[nolo] agent models requires a provider URL. Use --url <base>, --provider-url <base>, or CUSTOM_PROVIDER_URL.\n"
    );
    return 1;
  }
  if (!key) {
    output.write(
      "[nolo] agent models requires an API key. Use --api-key <key> or CUSTOM_API_KEY.\n"
    );
    return 1;
  }

  try {
    const res = await fetchImpl(joinBase(base, "/models"), {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = (await res.json().catch(() => null)) as
      | { data?: OpenAICompatModel[] }
      | null;
    const modelIds = (Array.isArray(body?.data) ? body!.data : [])
      .map((m) => m.id ?? m.name ?? "")
      .filter((id) => id);
    const filtered = filter
      ? modelIds.filter((id) => id.toLowerCase().includes(filter))
      : modelIds;

    if (wantJson) {
      output.write(
        JSON.stringify(
          { ok: res.ok, status: res.status, base, modelIds: filtered },
          null,
          2
        ) + "\n"
      );
      return res.ok ? 0 : 1;
    }

    if (!res.ok) {
      output.write(
        `[nolo] agent models failed (HTTP ${res.status}): ${JSON.stringify(body)}\n`
      );
      return 1;
    }
    if (!filtered.length) {
      output.write(
        `[nolo] agent models: no models found${
          filter ? ` matching "${filter}"` : ""
        } at ${base}\n`
      );
      return 1;
    }
    output.write(filtered.join("\n") + "\n");
    return 0;
  } catch (error) {
    output.write(`[nolo] agent models failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}

/**
 * Send a minimal chat-completion probe to an OpenAI-compatible endpoint.
 * Used by `nolo agent create --verify` to prove the key + endpoint + model work
 * end-to-end right after creating a custom-provider agent. Never logs the key.
 */
export async function verifyCustomProvider(options: {
  providerUrl: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  prompt?: string;
  fetchImpl?: CliFetchImpl;
}): Promise<{
  ok: boolean;
  status?: number;
  providerUrl: string;
  model?: string;
  reply?: string;
  reason?: string;
}> {
  const { providerUrl, apiKey, model, prompt = "只回复 OK" } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider = providerUrl?.replace(/\/+$/, "") ?? "";

  if (!provider || !apiKey || !model) {
    return {
      ok: false,
      providerUrl: provider,
      model,
      reason: "missing-provider-config (need --custom-provider-url + --api-key + --model)",
    };
  }

  try {
    const res = await fetchImpl(joinBase(provider, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 40,
      }),
    });
    const data = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string; reasoning_content?: string } }[] }
      | null;
    const message = data?.choices?.[0]?.message;
    const reply = (message?.content ?? message?.reasoning_content ?? "").trim();
    return { ok: res.ok, status: res.status, providerUrl: provider, model, reply };
  } catch (error) {
    return { ok: false, providerUrl: provider, model, reason: toErrorMessage(error) };
  }
}
