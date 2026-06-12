# Release Checklist

This checklist keeps `nolo-cli` releases reviewable from the public repository.
It is intended for maintainers preparing npm releases and source mirror updates.

## Before Publishing

- Confirm the package version and changelog entry.
- Confirm the version bump matches [RELEASE_POLICY.md](./RELEASE_POLICY.md):
  patch for focused fixes, `0.2.0` for a public milestone, and `1.0.0` only
  after the public CLI contract is stable.
- Run CLI smoke checks:

```bash
nolo --version
nolo doctor
nolo run "summarize the release risk for this repository"
```

- Run focused tests for changed modules when source is mirrored publicly.
- Check no-login local mode still works without a Nolo account token.
- Check authenticated commands still fail clearly when no token is configured.
- Review compatibility notes for built-in HTTP providers, custom
  OpenAI-compatible endpoints, doctor-detected credentials, and local CLI
  agents touched by the release.

## Security Boundary Review

- Confirm no credentials, tokens, private dialogs, private docs, private tables,
  user-data paths, signing secrets, billing paths, or production ops scripts are
  included in the public release.
- Confirm any shell, machine connector, provider key, or auth boundary change is
  documented in README, SECURITY, or maintainer workflow docs.
- Confirm provider docs describe where keys live and when remote workflows may use
  them.

## After Publishing

- Verify npm shows the expected package version.
- Confirm README and open-source status docs describe the published version.
- Open or update a release issue with:
  - npm version
  - smoke commands run
  - provider compatibility notes
  - known limitations
  - follow-up issues
- Tag follow-up work with labels such as `release`, `provider`,
  `local-runtime`, `desktop-local-mode`, or `docs`.
