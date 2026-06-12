# Roadmap

This roadmap tracks the public OSS work for `nolo-cli`.

## Phase 1: Public Project Shell

- Publish a clear README, license, contribution guide, and security policy.
- Link the public repository to the existing npm package.
- Document what is public now and what is still being mirrored from the private
  monorepo.

## Phase 2: Safe Source Mirror

- Add a repeatable source-mirroring script.
- Exclude private product infrastructure, credentials, production operations,
  internal agent records, and user-data paths.
- Mirror the CLI command surface and TUI shell.
- Mirror runtime doctor and smoke-check commands.

## Phase 3: Maintainer Workflow Examples

- Add examples for Codex-assisted PR review.
- Add examples for issue triage and release smoke checks.
- Add machine connector setup docs for local agent workflows.
- Add JSON output examples for automation scripts.

## Phase 4: Contributor-Friendly Runtime Modules

- Stabilize local-first agent runtime boundary types.
- Add focused tests for provider resolution, tool policy, and runtime doctor
  behavior.
- Split reusable runtime code into reviewable modules with documented entry
  points.
