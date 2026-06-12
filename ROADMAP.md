# Roadmap

This roadmap tracks the public OSS work for `nolo-cli`.

## Phase 1: Public Project Shell

- Publish a clear README, license, contribution guide, and security policy.
- Link the public repository to the existing npm package.
- Document what is public now and what is still being mirrored from the private
  monorepo.
- Add public issue and PR templates for bug reports, maintainer workflows, and
  boundary review.

## Phase 2: Safe Source Mirror

- Add a repeatable source-mirroring script.
- Exclude private product infrastructure, credentials, production operations,
  internal agent records, billing systems, signing credentials, and user-data
  paths.
- Mirror the CLI command surface and TUI shell.
- Mirror runtime doctor and smoke-check commands.
- Mirror the no-login `nolo run "task"` local Codex path.

## Phase 3: No-Login Local Mode

- Document provider setup for built-in HTTP providers, custom
  OpenAI-compatible endpoints, doctor-detected local credentials, and local CLI
  agent sessions.
- Keep provider credentials local by default and avoid requiring a Nolo account
  for repository-local review, triage, and release checks.
- Add desktop local-mode docs so users can run the desktop app with their own
  provider keys before signing in. Initial docs:
  [docs/desktop-local-mode.md](./docs/desktop-local-mode.md).
- Add tests around authless local runs, provider resolution, shell permission
  prompts, and local workspace summaries.

## Phase 4: Maintainer Workflow Examples

- Add examples for Codex-assisted PR review.
- Add examples for issue triage and release smoke checks.
- Add machine connector setup docs for local agent workflows.
- Add JSON output examples for automation scripts.
- Add a release checklist that records package version, smoke checks, and
  runtime compatibility.

## Phase 5: Contributor-Friendly Runtime Modules

- Stabilize local-first agent runtime boundary types.
- Add focused tests for provider resolution, tool policy, and runtime doctor
  behavior.
- Split reusable runtime code into reviewable modules with documented entry
  points.
- Publish a source mirror status checklist for each module so contributors can
  see what is public, what is pending, and what is intentionally private.
