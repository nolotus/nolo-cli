# Provider Setup

`nolo-cli` is moving toward local-first, bring-your-own-provider workflows for
OSS maintainers. Repository-local runs should work without a Nolo account;
provider credentials stay on the user's machine.

Start with [No-Login Local Mode Quickstart](./no-login-quickstart.md) if you
have not installed the CLI yet.

## Credential Boundary

Public docs and examples should reference environment variable names, not raw
API keys.

Good:

```bash
export OPENAI_API_KEY="<your-provider-key>"
nolo doctor
nolo run "review this repository"
```

Do not paste API keys, account tokens, private logs, private dialog content, or
machine tokens into public issues.

## Provider Categories

`nolo-cli` supports more than one provider shape. Keep these categories
separate when debugging or reporting issues.

| Category | What it means | Examples |
| --- | --- | --- |
| Built-in HTTP providers | Named providers with built-in chat-completions endpoints. | `openai`, `openrouter`, `deepseek`, `deepinfra`, `fireworks`, `google`, `mistral`, `mimo` |
| Custom OpenAI-compatible endpoints | Any provider exposing an OpenAI-compatible `/chat/completions` API. | local Ollama-compatible servers, proxy gateways, OpenRouter via `OPENAI_BASE_URL` |
| Local CLI agents | Local command-line coding agents that use their own local login/session. | `codex`, `claude`, `copilot`, `gemini`, `agy`, `qoder` |
| Doctor-detected env providers | Provider env vars currently surfaced by `nolo doctor`. | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `NOLO_LOCAL_OPENAI_BASE_URL`, `OLLAMA_BASE_URL` |

The categories overlap. For example, OpenRouter is both a built-in provider and
an OpenAI-compatible endpoint. Codex CLI and Qoder CLI are not API-key
providers; they are local CLI agent paths.

## Built-In HTTP Providers

The runtime has built-in endpoint names for these HTTP providers:

| Provider | Endpoint family | Credential note |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1/chat/completions` | Usually `OPENAI_API_KEY`. |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | Can use OpenAI-compatible envs. |
| `deepseek` | `https://api.deepseek.com/chat/completions` | Use the provider's key. |
| `deepinfra` | `https://api.deepinfra.com/v1/openai/chat/completions` | OpenAI-compatible shape. |
| `fireworks` | `https://api.fireworks.ai/inference/v1/chat/completions` | OpenAI-compatible shape. |
| `google` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `nolo doctor` detects `GOOGLE_API_KEY`. |
| `mistral` | `https://api.mistral.ai/v1/chat/completions` | Use the provider's key. |
| `mimo` | `https://token-plan-cn.xiaomimimo.com/v1/chat/completions` | Uses `api-key` auth header by default for Xiaomi Mimo endpoints. |

These built-in names are most relevant when an agent record already carries a
provider/model configuration. For a simple no-login local test, start with the
OpenAI-compatible env path below.

## OpenAI

Use an environment variable for local API access:

```bash
export OPENAI_API_KEY="<your-openai-api-key>"
nolo doctor
nolo run "review the current diff for correctness, security risk, and missing tests"
```

Expected `nolo doctor` provider shape:

```text
Provider: available (openai via env OPENAI_API_KEY)
```

Boundary:

- The key is read from your shell environment.
- No Nolo account token is required for repository-local runs.
- Synced Nolo agents, shared dialogs, docs, tables, and machine-bound hosted
  automation are separate authenticated workflows.

## Custom OpenAI-Compatible Endpoints

Use this path for providers that expose `/v1/chat/completions` or an equivalent
OpenAI-compatible chat-completions endpoint.

```bash
export NOLO_LOCAL_OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export NOLO_LOCAL_OPENAI_API_KEY="<local-or-provider-key>"
nolo doctor
nolo run "summarize release blockers in this repository"
```

`NOLO_LOCAL_OPENAI_BASE_URL` can be either a base URL or a full
`/chat/completions` URL. The CLI normalizes base URLs to `/chat/completions`.

Example endpoint shapes:

```bash
export NOLO_LOCAL_OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export NOLO_LOCAL_OPENAI_BASE_URL="http://127.0.0.1:8000/v1/chat/completions"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
```

Boundary:

- Prefer `NOLO_LOCAL_OPENAI_*` when you want config to be clearly local to
  `nolo-cli`.
- Keep real keys in your shell or local secret manager.
- Do not commit provider URLs that reveal private network topology.

## OpenRouter

OpenRouter can be used through the OpenAI-compatible path:

```bash
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_API_KEY="<your-openrouter-key>"
nolo doctor
nolo run "triage recent install failures and propose labels"
```

Boundary:

- The OpenRouter key remains a local provider credential.
- Public issues should mention provider name and model family, not the key.
- If a compatibility bug requires logs, remove Authorization headers, private
  prompts, and private repository paths before posting.

## Anthropic And Google Detection

`nolo doctor` currently recognizes these environment variables:

```bash
export ANTHROPIC_API_KEY="<your-anthropic-key>"
export GOOGLE_API_KEY="<your-google-key>"
nolo doctor
```

Expected provider shapes:

```text
Provider: available (anthropic via env ANTHROPIC_API_KEY)
Provider: available (google via env GOOGLE_API_KEY)
```

This means the CLI can diagnose those local credentials. A concrete local run
still depends on the configured agent/provider path. If a repository-local
command reports missing provider support, include the sanitized `nolo doctor`
output and provider name in the issue.

Boundary:

- Keep provider keys in your shell or local secret manager.
- Do not paste Authorization headers or raw API responses into public issues.
- If the issue is about general no-login local mode, include whether the
  OpenAI-compatible path works on the same machine.

## Local CLI Agents

Local CLI agents are different from HTTP API providers. They call another
command-line coding tool installed on your machine. That tool owns its login,
subscription, API key, or local session.

Supported CLI provider names in the runtime:

| CLI provider | Local tool/session | Notes |
| --- | --- | --- |
| `codex` | Codex CLI | Default local CLI agent path. |
| `claude` | Claude CLI / Claude Code | Supports native system prompt handling. |
| `copilot` | GitHub Copilot CLI path | Supports model and reasoning options where the CLI supports them. |
| `gemini` | Gemini CLI | Local CLI agent path. |
| `agy` | Antigravity CLI | Buffered result path. |
| `qoder` | Qoder CLI | Used by the built-in local Qoder virtual agent. |

Example:

```bash
codex --version
nolo doctor
nolo run "prepare a release smoke checklist for this package"
```

For Qoder:

```bash
qoder --version
nolo doctor
nolo run "summarize provider compatibility risks before release"
```

Boundary:

- CLI agent auth stays with that CLI provider.
- Do not copy CLI-provider tokens, cookies, account identifiers, or quota logs
  into public issues.
- Public reports should include OS, install method, CLI provider name, and
  sanitized command output.

## Troubleshooting

Run:

```bash
nolo --version
nolo doctor
```

Then check:

- The provider variable is set in the same shell where you run `nolo`.
- The variable name matches the provider path you intend to use.
- `OPENAI_BASE_URL` or `NOLO_LOCAL_OPENAI_BASE_URL` points at a base URL or
  `/chat/completions` endpoint.
- Local CLI providers are installed and logged in before you select them.
- You are in the repository you want the agent to inspect.
- Logs are sanitized before posting publicly.

Useful sanitized bug report fields:

```text
OS:
Shell:
nolo --version:
node --version:
npm --version:
provider category: built-in HTTP | custom OpenAI-compatible | local CLI agent | doctor-detected env
provider name:
sanitized nolo doctor output:
command that failed:
```

Never include:

- raw provider keys
- Nolo auth tokens
- Authorization headers
- private repository paths, if the path itself is sensitive
- private prompts, dialogs, tables, docs, or user data
