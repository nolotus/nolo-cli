# No-Login Local Mode Quickstart

This guide shows the local-first path for trying `nolo-cli` without signing in
to Nolo. It is intended for maintainers who want to run repository-local agent
workflows before using synced Nolo agents, dialogs, docs, tables, or machine
automation.

## What You Need

- Node.js and npm.
- A shell in the repository you want to inspect.
- One local provider path:
  - a local Codex CLI session,
  - a local Qoder CLI session,
  - or a BYOK provider configured in your shell, such as `OPENAI_API_KEY` or an
    OpenAI-compatible endpoint.

No Nolo account token is required for the local-only path.

## Install

Install the latest public package:

```bash
npm install -g nolo-cli
```

For a release-specific smoke check, install into a temporary prefix so your
global environment stays untouched:

```bash
SMOKE_ROOT="$(mktemp -d /tmp/nolo-cli-smoke-XXXXXX)"
npm install -g nolo-cli@0.1.45 --prefix "$SMOKE_ROOT"
"$SMOKE_ROOT/bin/nolo" --version
"$SMOKE_ROOT/bin/nolo" doctor
```

Expected shape:

```text
nolo-cli 0.1.45
Nolo CLI doctor
---------------
version  nolo-cli 0.1.45
server   https://nolo.chat
```

## Run A Local Task

From the repository you want the agent to inspect:

```bash
cd /path/to/your/repository
nolo run "review this repository for release blockers"
```

This path is meant to run against the current workspace. A Nolo login is not
required for repository-local review, triage, docs, release, or security tasks.

If your local provider is not configured yet, `nolo doctor` and the command
output should point you toward the missing provider or CLI setup. See
[Provider setup](./provider-setup.md) for built-in HTTP providers, custom
OpenAI-compatible endpoints, doctor-detected env providers, and local CLI
agents.

## What Works Without Nolo Sign-In

- Checking the installed CLI version.
- Running `nolo doctor`.
- Running local repository tasks through a configured local provider or local
  CLI provider.
- Reviewing a repository, diff, release checklist, documentation task, or
  security boundary from the current workspace.
- Keeping provider credentials on your machine.

Provider credentials may still be required by the provider itself. For example,
OpenAI-compatible runs may need an API key in your shell, while Codex CLI or
Qoder CLI runs may depend on those tools' own local login state.

## What Still Requires Nolo Sign-In

Sign in when you want hosted or synced Nolo state:

- synced agents
- shared dialogs
- docs and tables stored in Nolo
- team or account-scoped workflows
- machine-bound hosted automation
- remote connector dispatch

The no-login path should not silently upload provider keys, private dialogs, or
repository state to Nolo. If a workflow needs hosted Nolo state, it should say
why before asking for sign-in.

## Troubleshooting

Run these first:

```bash
nolo --version
nolo doctor
```

Then check:

- The `nolo` binary on your `PATH` is the version you expect.
- You are in the repository you want the agent to inspect.
- Your provider environment variable is set in the same shell.
- Your local CLI provider, if used, is installed and logged in.
- You removed secrets before posting logs to public issues.

For install-specific issues, include this information in a bug report:

- OS and shell.
- `node --version`.
- `npm --version`.
- `nolo --version`.
- The install command you used.
- Sanitized `nolo doctor` output.
