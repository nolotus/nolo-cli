# nolo-cli

Agent-first terminal workspace for Nolo.

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

## Project Status

This repository is the public OSS entry point for the CLI project. The package
is actively maintained and has frequent releases on npm.

The current implementation is developed in a broader private monorepo because
it shares product infrastructure with Nolo. Public source mirroring is being
prepared in a staged way so that reusable CLI and agent-runtime code can be
opened without exposing private product records, credentials, production
operations, or user-data paths.

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

## License

MIT
