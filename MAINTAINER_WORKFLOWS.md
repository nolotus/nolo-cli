# Maintainer Workflows

`nolo-cli` is designed for maintainers who need repeatable agent workflows
around active repositories. These examples describe the public OSS direction
and the source modules being mirrored into this repository.

## No-Login Local Review

Run a local Codex-style agent in the current repository:

```bash
nolo run "review this repository for release blockers"
```

This workflow should not require a Nolo account. It runs against the local
workspace and is intended for PR review, release checks, issue investigation,
and docs maintenance. The local provider may still require its own local CLI
login or API key.

## Pull Request Review

```bash
nolo run "review the current diff for correctness, security risk, and missing tests"
```

Maintainer expectations:

- Review should focus on behavioral regressions, security risks, and test gaps.
- The prompt should be reproducible from the PR conversation or release notes.
- Findings should cite files, commands, or test output when possible.

## Issue Triage

```bash
nolo run "triage recent install failures and propose labels, repro steps, and next actions"
```

Useful triage categories:

- `install`: npm, Bun, PATH, or platform setup issue.
- `provider`: built-in HTTP provider, custom OpenAI-compatible endpoint,
  doctor-detected credential, or local CLI agent compatibility.
- `local-runtime`: current workspace, shell permission, or runtime doctor issue.
- `desktop-local-mode`: no-login desktop and provider setup issue.
- `docs`: missing examples, unclear setup, or troubleshooting gap.

## Release Management

```bash
nolo doctor
nolo run "prepare a release smoke checklist for the current package"
```

Release review should capture:

- npm package version and changelog notes.
- Runtime doctor output.
- Targeted test or smoke-check commands.
- Known provider compatibility notes.
- Any security boundary changes around shell, machine connector, or credentials.

## Security Review

```bash
nolo run "review local credential handling and shell access boundaries in this change"
```

Security-sensitive review areas:

- Provider keys should remain local unless explicitly configured otherwise.
- Public provider config should store environment variable references, not raw
  API keys.
- `nolo run` style workflows should not require Nolo account tokens.
- Shell access should be scoped to the selected workspace.
- Machine connector workflows should document which server, token, and machine
  boundary is being used.

## Desktop Local Mode Direction

The desktop app should support useful local work before sign-in:

- Configure local provider keys or local CLI providers.
- Run a repository-local agent workflow without a Nolo account.
- Sign in only when the user wants synced agents, shared dialogs, docs, tables,
  or machine-bound hosted automation.

This direction keeps `nolo-cli` useful as standalone OSS tooling while allowing
Nolo-hosted collaboration to remain optional.
