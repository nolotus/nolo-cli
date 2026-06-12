# Desktop Local Mode

The Nolo desktop direction is local-first: users should be able to do useful
repository maintenance before signing in. Signing in should add synced and
hosted workflows, not be required for every local agent task.

## Intended First-Run Experience

Before sign-in, desktop local mode should support:

- choosing a local repository
- configuring a local provider or local CLI provider
- running a repository-local review, triage, docs, release, or security task
- seeing the runtime boundary before shell access is used
- keeping provider credentials on the user's machine

Example local task:

```bash
nolo run "review this repository for release blockers"
```

The desktop app should expose the same boundary in UI: local provider, selected
workspace, shell policy, and local-only persistence unless the user signs in and
chooses a synced workflow.

## What Does Not Require Nolo Sign-In

- Local PR review in the selected repository.
- Local issue triage or repro investigation.
- Local release checklist generation.
- Local docs maintenance.
- Local security review.
- Local provider setup for built-in HTTP providers, custom OpenAI-compatible
  endpoints, doctor-detected credentials, or local CLI agent sessions.

The local provider may still require its own API key or local CLI session.

## What Requires Sign-In

Sign-in is still appropriate for workflows that use hosted Nolo state:

- synced agents
- shared dialogs
- docs and tables stored in Nolo
- team or account-scoped workflows
- machine-bound hosted automation
- remote connector dispatch

The UI and docs should keep this boundary visible. A user should not need to
guess whether a task is local-only or synced/hosted.

## Runtime Boundary

Desktop local-mode behavior should match the public runtime boundary:

```ts
{
  requiresNoloAuth: false,
  credentialBoundary: "local-provider",
  shell: {
    policy: "prompted",
    scope: "workspace"
  },
  persistence: {
    localDialog: true,
    remoteSync: false
  }
}
```

Boundary principles:

- Provider credentials stay local unless the user explicitly configures a
  remote workflow.
- Shell access is scoped to the selected workspace.
- Remote sync is off by default for no-login local tasks.
- If a workflow needs Nolo auth, the desktop app should say why before asking
  the user to sign in.

## Provider Setup

See [provider-setup.md](./provider-setup.md) for local provider configuration.
The same credential rules apply in desktop local mode:

- store environment variable names or local CLI session references in public
  config
- do not store raw API keys in public config
- do not paste provider keys or account tokens into public issues
- sanitize logs before sharing them

## Maintainer Workflows

Desktop local mode should make these OSS maintainer workflows one-click or
prompt-driven over time:

- review the current repository
- review a diff before merge
- triage an install or provider issue
- run a release checklist
- review local credential and shell boundaries
- prepare docs updates

The command-line equivalents remain the source of truth for public examples so
the workflows are inspectable and scriptable.
