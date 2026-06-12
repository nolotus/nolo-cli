# Open Source Status

`nolo-cli` is already distributed as a public npm package. This repository is
the public home for the project and the staging area for opening the reusable
source modules that matter to OSS maintainers.

## Current State

- Public npm package: `nolo-cli`
- Current published version: `0.1.45`
- License: MIT
- Public repository: `nolotus/nolo-cli`
- Active maintainer: Bin Zhang / `nolotus`
- Primary user signal: npm reports about 3.5k downloads/month for the window
  ending 2026-06-02

## Source Authority

This repository now carries the publish-safe package source used for public
review, CI, npm packing, and npm publishing. Version `0.1.45` was published
from the public GitHub Actions npm workflow. The broader Nolo monorepo can still
stage package updates, but public releases should be reviewed and published
from this repository after the public CI and npm workflow pass. Versioning
criteria are documented in [RELEASE_POLICY.md](./RELEASE_POLICY.md).

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

- Keep npm publish authority in this public repository.
- Keep no-login `nolo run "task"` local Codex workflows runnable from the
  public source root.
- Keep BYOK provider configuration docs current for CLI and desktop local mode.
- Add more public maintainer workflow examples for PR review, issue triage,
  release checks, docs maintenance, and security review.

## Public Maintenance Signals

This repository is being organized so reviewers and contributors can inspect
ongoing maintenance work:

- Public issues track source mirroring, install docs, maintainer workflows,
  BYOK provider setup, and release checks.
- Future pull requests should be small enough to review in public and should
  include focused tests or docs.
- Releases should document npm version, smoke checks, and known runtime
  compatibility notes.
- Version milestones should follow [RELEASE_POLICY.md](./RELEASE_POLICY.md), so
  `0.2.0` and `1.0.0` mean public contract progress rather than cosmetic bumps.
- Source mirroring progress is tracked in
  [SOURCE_MIRROR_CHECKLIST.md](./SOURCE_MIRROR_CHECKLIST.md).
- Security reports should go through the private disclosure path in
  [SECURITY.md](./SECURITY.md).
