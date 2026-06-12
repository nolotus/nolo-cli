# Open Source Status

`nolo-cli` is already distributed as a public npm package. This repository is
the public home for the project and the staging area for opening the reusable
source modules.

## Current State

- Public npm package: `nolo-cli`
- Current published version: `0.1.41`
- License: MIT
- Public repository: `nolotus/nolo-cli`

## Why Source Mirroring Is Staged

The CLI started inside the broader Nolo monorepo. Some implementation files
touch private product infrastructure, production operations, internal agent
records, and user-data paths. Those pieces should not be mirrored blindly.

The staged process is meant to keep the useful OSS surface public while keeping
private operational details private.

## Public Source Criteria

A file or module is suitable for this repository when it:

- Implements reusable CLI, TUI, agent-runtime, or maintainer workflow logic.
- Does not include credentials, private tokens, or production secrets.
- Does not hard-code private agent records, user IDs, internal task boards, or
  operator-only workflows.
- Has enough README, examples, or tests for an outside contributor to review.

## Near-Term Migration Targets

- CLI command registry and help output.
- TUI session shell.
- Runtime doctor and smoke-check commands.
- Local-first agent runtime boundary types.
- Example Codex maintainer workflows.
