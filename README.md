# nolo-cli

Agent-first terminal workspace for Nolo.

[![npm version](https://img.shields.io/npm/v/nolo-cli.svg)](https://www.npmjs.com/package/nolo-cli)
[![npm downloads](https://img.shields.io/npm/dm/nolo-cli.svg)](https://www.npmjs.com/package/nolo-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

`nolo-cli` is a Bun-powered command-line and TUI client for working with local
and remote AI agents. It focuses on practical maintainer workflows: agent chat,
dialog/doc/table operations, machine connector commands, runtime diagnostics,
and automation-friendly JSON commands.

The npm package is published as `nolo-cli`:

```bash
npm install -g nolo-cli
nolo
nolo doctor
nolo --version
```

## Why This Matters

Open-source maintainers are increasingly using coding agents for issue triage,
pull-request review, release checks, documentation, and repository maintenance.
Those workflows need more than a single chat box: they need repeatable command
entry points, local runtime checks, machine binding, structured task/dialog
history, and automation-friendly output.

`nolo-cli` is aimed at that layer. It is designed to make agent-maintainer
workflows inspectable and scriptable, while keeping local runtime boundaries
clear.

## Project Status

This repository is the public OSS entry point for the CLI project. The package
is actively maintained and has frequent releases on npm. As of June 2026,
`nolo-cli` is published at version `0.1.41`; npm reports about 3.5k downloads
for the last-month window ending 2026-06-02.

The current implementation is developed in a broader private monorepo because
it shares product infrastructure with Nolo. Public source mirroring is being
prepared in a staged way so that reusable CLI and agent-runtime code can be
opened without exposing private product records, credentials, production
operations, or user-data paths.

See [OPEN_SOURCE_STATUS.md](./OPEN_SOURCE_STATUS.md) and
[ROADMAP.md](./ROADMAP.md) for the public-source migration plan.

## Maintenance Scope

The public maintenance scope for this project is:

- Agent-first terminal and TUI workflows.
- CLI commands for agents, dialogs, docs, tables, and machines.
- Local-first agent runtime boundaries.
- Runtime doctor and smoke-check workflows.
- Release checks and automation helpers for OSS maintainers.

## Links

- npm package: https://www.npmjs.com/package/nolo-cli
- Nolo: https://nolo.chat
- Open-source status: [OPEN_SOURCE_STATUS.md](./OPEN_SOURCE_STATUS.md)
- Roadmap: [ROADMAP.md](./ROADMAP.md)

## License

MIT
