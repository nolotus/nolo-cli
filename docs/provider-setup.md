# BYOK Provider Setup

`nolo-cli` is moving toward local-first, bring-your-own-key workflows for OSS
maintainers. Repository-local runs should work without a Nolo account; provider
credentials stay on the user's machine.

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

## Supported Local Provider Paths

| Provider path | Environment or local state | No Nolo sign-in? | Notes |
| --- | --- | --- | --- |
| OpenAI-compatible HTTP | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` | Yes | Default direct local provider path. |
| Explicit local OpenAI-compatible HTTP | `NOLO_LOCAL_OPENAI_API_KEY`, `NOLO_LOCAL_OPENAI_BASE_URL` | Yes | Prefer these when you want provider config to be clearly local to `nolo-cli`. |
| OpenRouter | `OPENAI_API_KEY`, `OPENAI_BASE_URL=https://openrouter.ai/api/v1` | Yes | Uses the OpenAI-compatible path. |
| Ollama-compatible local endpoint | `NOLO_LOCAL_OPENAI_BASE_URL` or `OLLAMA_BASE_URL` | Yes | Use a local OpenAI-compatible endpoint when available. |
| Anthropic | `ANTHROPIC_API_KEY` | Yes for detection | `nolo doctor` detects it; local run support depends on the configured agent/provider path. |
| Google | `GOOGLE_API_KEY` | Yes for detection | `nolo doctor` detects it; local run support depends on the configured agent/provider path. |
| Codex CLI | local Codex CLI session | Yes | Uses the provider's own local auth/session. |
| Qoder CLI | local Qoder CLI session | Yes | Uses the provider's own local auth/session. |

Run `nolo doctor` after setting provider variables. It reports whether the CLI
sees a provider and which local capabilities are missing.

## OpenAI

Use an environment variable for local API access:

```bash
export OPENAI_API_KEY="<your-openai-api-key>"
nolo doctor
nolo run "review the current diff for correctness, security risk, and missing tests"
```

Expected `nolo doctor` provider shape:

```text
provider openai via env OPENAI_API_KEY
```

Boundary:

- The key is read from your shell environment.
- No Nolo account token is required for repository-local runs.
- Synced Nolo agents, shared dialogs, docs, tables, and machine-bound hosted
  automation are separate authenticated workflows.

## OpenAI-Compatible Endpoints

Use this path for providers that expose `/v1/chat/completions`.

```bash
export NOLO_LOCAL_OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export NOLO_LOCAL_OPENAI_API_KEY="<local-or-provider-key>"
nolo doctor
nolo run "summarize release blockers in this repository"
```

`NOLO_LOCAL_OPENAI_BASE_URL` can be either a base URL or a full
`/chat/completions` URL. The CLI normalizes base URLs to `/chat/completions`.

Example local endpoint shapes:

```bash
export NOLO_LOCAL_OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export NOLO_LOCAL_OPENAI_BASE_URL="http://127.0.0.1:8000/v1/chat/completions"
```

Boundary:

- Prefer `NOLO_LOCAL_OPENAI_*` for local-only examples.
- Keep real keys in your shell or local secret manager.
- Do not commit provider URLs that reveal private network topology.

## OpenRouter

OpenRouter works through the OpenAI-compatible path:

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

## Anthropic

`nolo doctor` recognizes Anthropic credentials:

```bash
export ANTHROPIC_API_KEY="<your-anthropic-key>"
nolo doctor
```

Expected provider shape:

```text
provider anthropic via env ANTHROPIC_API_KEY
```

Use this path when your configured agent/provider supports Anthropic. If a
repository-local command still reports missing provider support, include the
sanitized `nolo doctor` output and provider name in the issue.

Boundary:

- Keep the Anthropic key in your shell or local secret manager.
- Do not paste Authorization headers or raw API responses into public issues.
- If the issue is about general no-login local mode, include whether the
  OpenAI-compatible path works on the same machine.

## Codex CLI

For Codex CLI-backed local runs, the provider uses the local Codex CLI session
or CLI auth state instead of an API key environment variable.

```bash
codex --version
nolo doctor
nolo run "prepare a release smoke checklist for this package"
```

Boundary:

- The local Codex CLI session is managed outside Nolo.
- `nolo-cli` should not require a Nolo login for this repository-local flow.
- Shell access remains scoped to the selected workspace and should be surfaced
  by command output or docs.

## Qoder CLI

For Qoder-backed local runs, verify Qoder first, then run `nolo` from the target
repository:

```bash
qoder --version
nolo doctor
nolo run "summarize provider compatibility risks before release"
```

Boundary:

- Qoder auth stays with Qoder.
- Do not copy Qoder tokens, cookies, account identifiers, or quota logs into
  public issues.
- Public reports should include OS, install method, provider name, and sanitized
  command output.

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
- Local CLI providers such as Codex CLI or Qoder CLI are installed and logged
  in.
- You are in the repository you want the agent to inspect.
- Logs are sanitized before posting publicly.

Useful sanitized bug report fields:

```text
OS:
Shell:
nolo --version:
node --version:
npm --version:
provider path: OpenAI-compatible | OpenRouter | Anthropic | Codex CLI | Qoder CLI | other
sanitized nolo doctor output:
command that failed:
```

Never include:

- raw provider keys
- Nolo auth tokens
- Authorization headers
- private repository paths, if the path itself is sensitive
- private prompts, dialogs, tables, docs, or user data
