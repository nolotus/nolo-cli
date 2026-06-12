# Security Policy

Please report security issues privately by emailing s@nolotus.com.

Do not open public issues containing credentials, access tokens, private dialog
content, production machine details, or reproducible exploit material.

## Security Scope

The public OSS scope includes:

- CLI command parsing and local runtime boundaries.
- No-login local agent runs.
- BYOK provider configuration and local credential handling.
- Desktop local-mode behavior that can run before sign-in.
- Machine connector permission boundaries when documented or mirrored publicly.

## Boundary Principles

- Provider API keys should stay local unless a user explicitly configures a
  remote workflow that needs them.
- Nolo account tokens are not required for repository-local `nolo run` style
  workflows.
- Shell access must be explicit, scoped to the chosen workspace, and documented
  in command output or workflow docs.
- Public BYOK config examples should reference environment variable names,
  never raw API keys.
- Production operations, billing systems, signing credentials, private agent
  records, and user-data paths are intentionally outside the public source
  boundary.
