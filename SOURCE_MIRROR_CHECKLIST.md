# Source Mirror Checklist

The public repository is moving from a project shell to the authoritative OSS
home for reusable `nolo-cli` modules. Each mirrored module should satisfy this
checklist before it lands.

## Module Readiness

- The module implements reusable CLI, TUI, local runtime, provider adapter,
  desktop local-mode, test, or maintainer workflow logic.
- Private Nolo adapters are split away from reusable logic.
- The module has public docs or examples explaining how an outside contributor
  can run or review it.
- The module has focused tests, smoke commands, or a clear manual verification
  path.

## Boundary Check

- No credentials, provider keys, account tokens, machine tokens, signing
  secrets, private environment files, or production deployment details.
- No private user data, private dialogs, private docs, private tables, internal
  task-board rows, or private agent records.
- No hard-coded operator-only workflow that an outside maintainer cannot
  understand or test.
- Public URLs are documented as configuration defaults, not as hidden authority.

## Priority Order

1. CLI command router, help output, and no-login `nolo run` path.
2. Local-first agent runtime boundary types and current-workspace execution.
3. Runtime doctor and release smoke-check commands.
4. Provider configuration docs and adapters.
5. Desktop local-mode setup and no-login behavior.
6. Maintainer workflow examples for PR review, issue triage, release checks,
   docs maintenance, and security review.

## Mirrored Modules

| Module | Status | Notes |
| --- | --- | --- |
| `index.ts` | Canonical | Public CLI entrypoint for installed and source-root runs. |
| `commandRegistry.ts` | Canonical | Public command routing surface. |
| `client/` | Canonical | Public CLI client, local runtime adapter, provider resolver, profile config, and focused tests. |
| `agent-runtime/` | Canonical | Local-first agent loop, runtime policy, local workspace tools, and Nolo workspace tool boundary. |
| `tui/` | Canonical | Public TUI session and workspace readline support. |
| `ai/agent/cliExecutor.ts` | Canonical | Local CLI provider execution path for Codex, Claude, Copilot, Gemini, Antigravity, Qoder, and related local agents. |
| `runtimeDoctorCommands.ts` | Canonical | Runtime diagnostics exposed to users and maintainers. |
| `docs/provider-setup.md` | Public docs | Provider setup guide for built-in HTTP providers, custom OpenAI-compatible endpoints, doctor-detected credentials, local CLI agents, and local provider boundaries. |
| `docs/desktop-local-mode.md` | Public docs | Desktop local-mode boundary and first-run direction for no-login provider workflows. |
| `.github/workflows/test.yml` | Public CI | Runs install, tests, package metadata checks, and pack dry-run. |
| `.github/workflows/npm-publish.yml` | Public release | Manual npm publish workflow guarded by expected version, tests, pack dry-run, and duplicate-version check. |

## Maintainer Evidence

For each source mirror PR, include:

- What maintainer workflow this enables.
- Why the module is safe to open.
- Tests or smoke commands run.
- Follow-up issues for missing docs, provider support, or boundary cleanup.
