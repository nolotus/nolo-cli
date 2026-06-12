# Release Policy

This project uses SemVer, npm, and the public GitHub Actions workflow as the
release source of truth.

## Version Line

`nolo-cli` is still on the `0.1.x` line because the public source boundary is
actively being opened while the CLI surface is still settling. This is valid
SemVer: before `1.0.0`, minor versions may still carry compatibility changes.

The `0.1.x` line is appropriate for:

- Patch releases that improve the existing CLI, TUI, local runtime, provider
  setup, release checks, docs, and public source boundary.
- Public npm releases where users can install and test the package, but the
  project still wants room to adjust command names or runtime defaults.
- OSS-readiness work that makes maintenance, review, and release signals more
  visible.

## When To Use 0.2.0

Use `0.2.0` when the project has a clear user-facing milestone rather than only
internal cleanup. Good triggers include:

- No-login local mode is documented and works from a fresh public checkout.
- Provider setup covers the main supported provider categories.
- Public issues and PRs can validate install, doctor, local run, and release
  smoke workflows without private Nolo access.
- Any command behavior change is intentional and documented.

`0.2.0` is a good next public milestone if the goal is to show more maturity to
OSS reviewers while still preserving pre-`1.0.0` flexibility.

## When To Use 1.0.0

Use `1.0.0` only after the public contract is stable enough that users can rely
on command names, no-login behavior, provider configuration, local persistence,
and release workflow semantics without frequent breaking changes.

Before `1.0.0`, the public repository should have:

- A stable install path.
- A stable no-login local run path.
- Clear provider setup docs.
- A documented support/security boundary.
- Passing public CI.
- At least one repeatable maintainer workflow for PR review, issue triage, and
  release checks.

## Release Tooling

The current release mechanism is intentionally simple:

1. Update `package.json`.
2. Open a public PR.
3. Let public CI pass.
4. Publish with `.github/workflows/npm-publish.yml`.
5. Verify npm shows the expected version.

Do not add release automation libraries unless they remove real maintainer
work. Tools such as Changesets, semantic-release, or release-please can be
useful later, but they are unnecessary while there is one package and releases
are manually reviewed. Adding them now would create more policy surface than it
removes.

Reconsider a release tool when:

- Multiple packages need coordinated versions.
- Public changelogs become hard to maintain by hand.
- External contributors regularly submit release-worthy PRs.
- Release notes need to be generated from labels or conventional commits.

Until then, GitHub Actions plus this policy and the release checklist are the
maintainable path.
