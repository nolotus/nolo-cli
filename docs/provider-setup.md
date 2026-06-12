# BYOK Provider Setup

`nolo-cli` is moving toward local-first, bring-your-own-key workflows for OSS
maintainers. Repository-local runs should work without a Nolo account; provider
credentials stay on the user's machine.

## Local Credential Rule

Public config and examples should reference environment variable names, not raw
API keys.

Good:

```bash
export OPENAI_API_KEY="..."
nolo run "review this repository"
```

Public config shape:

```ts
{
  provider: "openai",
  auth: {
    kind: "env",
    envVar: "OPENAI_API_KEY"
  },
  localOnly: true,
  requiresNoloAuth: false
}
```

Do not paste API keys, account tokens, private logs, private dialog content, or
machine tokens into public issues.

## OpenAI

Use an environment variable for local API access:

```bash
export OPENAI_API_KEY="sk-..."
nolo run "review the current diff for correctness, security risk, and missing tests"
```

Boundary:

- The key is read locally by the provider integration.
- No Nolo account token is required for repository-local runs.
- Synced Nolo agents, shared dialogs, docs, tables, and machine-bound hosted
  automation are separate authenticated workflows.

## OpenRouter

Use an OpenRouter key through an environment variable:

```bash
export OPENROUTER_API_KEY="sk-or-..."
nolo run "triage recent install failures and propose labels"
```

Boundary:

- The OpenRouter key remains a local provider credential.
- Public issues should mention provider name and model family, not the key.
- If a provider compatibility bug requires logs, remove Authorization headers,
  private prompts, and private repository paths before posting.

## Codex CLI

For Codex CLI-backed local runs, the provider may use the local Codex session or
CLI auth state instead of an API key environment variable.

```bash
nolo run "prepare a release smoke checklist for this package"
```

Boundary:

- The local Codex CLI session is managed outside Nolo.
- `nolo-cli` should not require a Nolo login for this repository-local flow.
- Shell access remains scoped to the selected workspace and should be surfaced
  by command output or docs.

## Qoder And Other Local CLI Providers

Local CLI providers can be used when the provider has a local command/session
that can run in the current repository.

```bash
nolo run "summarize provider compatibility risks before release"
```

Boundary:

- Provider-specific auth stays with that provider.
- Nolo auth is only needed for optional synced or hosted workflows.
- Public bug reports should include provider name, OS, install method, and
  sanitized logs.

## When Nolo Auth Is Still Needed

Repository-local maintainer workflows should not require Nolo auth:

- local PR review
- local issue triage
- local release checklist generation
- local docs maintenance
- local security review

Nolo auth may still be required for:

- synced agents
- shared dialogs
- docs and tables stored in Nolo
- machine-bound hosted automation
- team or account-scoped workflows

## Troubleshooting Checklist

- Run `nolo --version`.
- Run `nolo doctor`.
- Confirm the provider environment variable is set in the same shell.
- Confirm the local provider CLI, if used, is installed and logged in.
- Confirm the working directory is the repository you want the agent to inspect.
- Remove secrets before posting logs to GitHub.
