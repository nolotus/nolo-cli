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
4. BYOK provider configuration docs and adapters.
5. Desktop local-mode setup and no-login behavior.
6. Maintainer workflow examples for PR review, issue triage, release checks,
   docs maintenance, and security review.

## Mirrored Modules

| Module | Status | Notes |
| --- | --- | --- |
| `src/localRun.ts` | Mirrored | Public no-login local run parser and usage text for `nolo run` / `nolo chat`. |
| `src/localRun.test.ts` | Mirrored | Tests local Codex shorthand behavior, explicit agent behavior, and empty-input usage. |
| `src/providerConfig.ts` | Mirrored | Public BYOK provider config shape that stores env var references instead of raw keys. |
| `src/providerConfig.test.ts` | Mirrored | Tests OpenAI env-var config, raw key rejection, and local/remote credential boundary text. |
| `src/runtimeBoundary.ts` | Mirrored | Public local runtime boundary for CLI and desktop no-login workflows. |
| `src/runtimeBoundary.test.ts` | Mirrored | Tests no-login workspace scope, shell policy, local persistence, and desktop local-mode summary. |
| `docs/provider-setup.md` | Mirrored | Public BYOK setup guide for OpenAI, OpenRouter, Codex CLI, Qoder, and local provider boundaries. |
| `docs/desktop-local-mode.md` | Mirrored | Public desktop local-mode boundary and first-run direction for no-login BYOK workflows. |

## Maintainer Evidence

For each source mirror PR, include:

- What maintainer workflow this enables.
- Why the module is safe to open.
- Tests or smoke commands run.
- Follow-up issues for missing docs, provider support, or boundary cleanup.
