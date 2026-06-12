# Open Source Status

`nolo-cli` is already distributed as a public npm package. This repository is
the public home for the project and the staging area for opening the reusable
source modules that matter to OSS maintainers.

## Current State

- Public npm package: `nolo-cli`
- Current published version: `0.1.41`
- License: MIT
- Public repository: `nolotus/nolo-cli`
- Active maintainer: Bin Zhang / `nolotus`
- Primary user signal: npm reports about 3.5k downloads/month for the window
  ending 2026-06-02

## Why Source Mirroring Is Staged

The CLI started inside the broader Nolo monorepo. Some implementation files
touch private product infrastructure, production operations, internal agent
records, billing paths, signing configuration, and user-data paths. Those
pieces should not be mirrored blindly.

The staged process is meant to keep the useful OSS surface public while keeping
private operational details private.

## Public Source Criteria

A file or module is suitable for this repository when it:

- Implements reusable CLI, TUI, agent-runtime, provider adapter, desktop
  local-mode, or maintainer workflow logic.
- Does not include credentials, private tokens, or production secrets.
- Does not hard-code private agent records, user IDs, internal task boards, or
  operator-only workflows.
- Has enough README, examples, or tests for an outside contributor to review.
- Can be maintained from public issues, PRs, tests, release notes, and security
  reports without needing private Nolo production access.

## Near-Term Migration Targets

- CLI command registry and help output.
- TUI session shell.
- Runtime doctor and smoke-check commands.
- Local-first agent runtime boundary types.
- No-login `nolo run "task"` local Codex workflow.
- BYOK provider configuration docs for CLI and desktop local mode.
- Example Codex maintainer workflows.

## Public Maintenance Signals

This repository is being organized so reviewers and contributors can inspect
ongoing maintenance work:

- Public issues track source mirroring, install docs, maintainer workflows,
  BYOK provider setup, and release checks.
- Future pull requests should be small enough to review in public and should
  include focused tests or docs.
- Releases should document npm version, smoke checks, and known runtime
  compatibility notes.
- Source mirroring progress is tracked in
  [SOURCE_MIRROR_CHECKLIST.md](./SOURCE_MIRROR_CHECKLIST.md).
- Security reports should go through the private disclosure path in
  [SECURITY.md](./SECURITY.md).
