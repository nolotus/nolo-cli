# nolo-cli

Local-first agent automation for open-source maintainers.

[![npm version](https://img.shields.io/npm/v/nolo-cli.svg)](https://www.npmjs.com/package/nolo-cli)
[![npm downloads](https://img.shields.io/npm/dm/nolo-cli.svg)](https://www.npmjs.com/package/nolo-cli)
[![test](https://github.com/nolotus/nolo-cli/actions/workflows/test.yml/badge.svg)](https://github.com/nolotus/nolo-cli/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

`nolo-cli` is a Bun-powered command-line and TUI client for running local and
remote AI agents around real repository maintenance. It focuses on practical
open-source maintainer workflows: Codex-assisted review, issue triage, release
smoke checks, docs updates, runtime diagnostics, and automation-friendly JSON
commands.

The project is moving toward a no-login, bring-your-own-key local mode:

- `nolo run "review this repository"` runs a local Codex-style agent in the
  current repository without requiring a Nolo account.
- Authenticated Nolo workflows remain available for synced agents, dialogs,
  docs, tables, and machine-bound automation.
- The desktop direction is local-first by default: users should be able to run
  with their own OpenAI, Anthropic, OpenRouter, Codex CLI, Qoder, or other
  provider credentials without depending on hosted Nolo infrastructure.

The npm package is published as `nolo-cli`:

```bash
npm install -g nolo-cli
nolo
nolo doctor
nolo --version
nolo run "review this repository"
```

## Why This Matters

Open-source maintainers are increasingly using coding agents for issue triage,
pull-request review, release checks, documentation, and repository maintenance.
Those workflows need more than a single chat box: they need repeatable command
entry points, local runtime checks, scoped shell permissions, structured
task/dialog history, release smoke checks, and automation-friendly output.

`nolo-cli` is aimed at that layer. It is designed to make agent-maintainer
workflows inspectable and scriptable, while keeping local runtime boundaries
clear.

## Maintainer Workflows

The project is built around ongoing maintainer duties that can be reviewed,
tested, and improved in public:

- **Pull request review:** run local Codex or another CLI agent against a diff,
  ask for risk-focused review, and keep the review prompt reproducible.
- **Issue triage:** classify bug reports, installation failures, runtime
  provider issues, and docs gaps into actionable labels.
- **Release management:** run doctor checks, smoke checks, changelog review,
  and package verification before publishing.
- **Security review:** keep shell, machine connector, BYOK provider, and token
  boundaries explicit so contributors can reason about local access.

See [MAINTAINER_WORKFLOWS.md](./MAINTAINER_WORKFLOWS.md) for concrete command
patterns and [OPEN_SOURCE_BOUNDARY.md](./OPEN_SOURCE_BOUNDARY.md) for what is
being opened versus intentionally kept private.

## Public Source

The first reusable source modules are now mirrored in this repository:

- [`src/localRun.ts`](./src/localRun.ts) documents and tests the no-login local
  run contract for `nolo run` and `nolo chat`.
- [`src/providerConfig.ts`](./src/providerConfig.ts) documents the BYOK
  provider credential boundary: public config stores environment variable
  references, not raw API keys.
- [`src/runtimeBoundary.ts`](./src/runtimeBoundary.ts) documents the local
  runtime boundary for no-login CLI and desktop flows: local provider
  credentials, workspace-scoped shell policy, local persistence, and no remote
  sync by default.
- [`src/localRun.test.ts`](./src/localRun.test.ts) verifies that shorthand runs
  use local Codex without requiring Nolo auth, while explicit agent runs remain
  distinct.

Run the public tests with:

```bash
bun test src
```

Current public source status:

| Area | Public evidence |
| --- | --- |
| No-login local run | `src/localRun.ts`, `src/localRun.test.ts`, passing GitHub Actions |
| BYOK provider boundary | `src/providerConfig.ts`, `src/providerConfig.test.ts`, PR #8 |
| Local runtime boundary | `src/runtimeBoundary.ts`, `src/runtimeBoundary.test.ts`, PR #8 |
| Release management | `RELEASE_CHECKLIST.md`, issue #9 |
| Source mirror safety | `OPEN_SOURCE_BOUNDARY.md`, `SOURCE_MIRROR_CHECKLIST.md`, issues #1 and #5 |

## Project Status

This repository is the public OSS entry point for the CLI project. The package
is actively maintained and has frequent releases on npm. As of June 2026,
`nolo-cli` is published at version `0.1.44`; npm reports about 3.5k downloads
for the last-month window ending 2026-06-02. Version `0.1.44` was published
from the public `nolotus/nolo-cli` GitHub Actions npm workflow.

The current implementation is developed in a broader private monorepo because
it shares product infrastructure with Nolo. Public source mirroring is being
managed in a staged way so that reusable CLI, local runtime, provider adapter,
desktop local-mode, docs, tests, and maintainer workflow code can be opened
without exposing private product records, credentials, production operations,
billing systems, or user-data paths.

See [OPEN_SOURCE_STATUS.md](./OPEN_SOURCE_STATUS.md) and
[ROADMAP.md](./ROADMAP.md) for the public-source migration plan.

## Maintenance Scope

The public maintenance scope for this project is:

- Agent-first terminal and TUI workflows for OSS maintainers.
- No-login local agent runs in the current repository.
- BYOK provider configuration for CLI and desktop local mode.
- Local-first agent runtime boundaries and scoped shell permissions.
- Runtime doctor, release smoke-check, and package verification workflows.
- Optional authenticated commands for synced Nolo agents, dialogs, docs, tables,
  and machine connectors.

## Links

- npm package: https://www.npmjs.com/package/nolo-cli
- Nolo: https://nolo.chat
- Maintainer workflows: [MAINTAINER_WORKFLOWS.md](./MAINTAINER_WORKFLOWS.md)
- Open-source boundary: [OPEN_SOURCE_BOUNDARY.md](./OPEN_SOURCE_BOUNDARY.md)
- Open-source status: [OPEN_SOURCE_STATUS.md](./OPEN_SOURCE_STATUS.md)
- Roadmap: [ROADMAP.md](./ROADMAP.md)
- BYOK provider setup: [docs/provider-setup.md](./docs/provider-setup.md)
- Desktop local mode: [docs/desktop-local-mode.md](./docs/desktop-local-mode.md)
- Release checklist: [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)
- Source mirror checklist: [SOURCE_MIRROR_CHECKLIST.md](./SOURCE_MIRROR_CHECKLIST.md)

## License

MIT
