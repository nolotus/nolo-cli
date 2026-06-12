# Open Source Boundary

`nolo-cli` is being opened as the reusable maintainer tooling layer from the
broader Nolo system. The goal is to make the useful local-first agent workflows
public without exposing private product infrastructure or user data.

## Intended Public Surface

- CLI command router, help output, and command implementations that are useful
  outside Nolo-hosted infrastructure.
- Local-first agent runtime boundaries, including current-repository execution,
  workspace summaries, runtime doctor checks, and smoke checks.
- No-login local agent workflows such as `nolo run "review this repository"`.
- BYOK provider configuration for OpenAI, Anthropic, OpenRouter, Codex CLI,
  Qoder, and other compatible local providers.
- Desktop local mode that lets users run with their own keys before signing in.
- Maintainer workflow examples for PR review, issue triage, release checks,
  documentation updates, and security review.
- Tests and docs that let outside contributors review behavior in public.

## Intentionally Private

- Production Nolo server operations, deployment scripts, billing systems, and
  private infrastructure configuration.
- Credentials, signing keys, machine tokens, account tokens, provider keys, and
  private environment files.
- User data, local profile contents, private dialogs, private docs, private
  tables, and internal task-board records.
- Private agent records, operator-only workflows, and product experiments that
  are not needed to run the OSS maintainer tool locally.
- Apple notarization credentials, release signing secrets, and private package
  publishing credentials.

## Migration Rule

A module should move into this repository only when it can be maintained through
public issues, public pull requests, focused tests, and public docs. If a module
needs private production access to understand or test, it should first be split
so the reusable public part is separate from the private adapter.

## Why This Boundary Matters

The project is most useful to OSS maintainers when it is inspectable and
hackable. It is also only safe to open if contributors can reason about local
credentials, shell access, machine connectors, and provider configuration
without needing private Nolo context.
