# Contributing

Thanks for your interest in `nolo-cli`.

The public repository is being staged from a private monorepo. Until the source
mirror is fully opened, the best contribution paths are:

- Open issues for CLI bugs, install failures, and workflow gaps.
- Request examples or docs for agent, dialog, table, and machine commands.
- Suggest reusable agent-maintainer workflows that should be documented.
- Review public source-mirroring pull requests for accidental private
  infrastructure references.
- Help test no-login local mode with different local providers and operating
  systems.

Please do not include credentials, API keys, personal account tokens, private
dialog content, or production machine details in issues.

## Good First Contributions

- Improve install and troubleshooting docs for Bun, npm, and CLI PATH issues.
- Add an example prompt for PR review, issue triage, release smoke checks, or
  documentation maintenance.
- File a provider compatibility report for OpenAI, Anthropic, OpenRouter,
  Codex CLI, Qoder, or another local-compatible provider.
- Propose a focused test case for no-login local runs or runtime doctor output.

## Maintainer Review Expectations

Public PRs should keep a small review surface. A good PR includes:

- A clear description of the maintainer workflow it improves.
- Tests or command output for behavior changes.
- Docs updates when commands, auth boundaries, or provider setup changes.
- No credentials, private agent records, production URLs that are not already
  public, or user-data paths.
