/**
 * Local workspace tool schema variants.
 *
 * Extracted from localRuntimeAdapter.ts. Pure env-driven functions that
 * select which description/parameter variant each workspace tool (listFiles,
 * readFile, globFiles, searchFiles) uses in its OpenAI function schema.
 *
 * No module state — only reads env vars.
 */
import type { EnvLike } from "./localRuntimeHelpers";

/**
 * Whether the CLI local runtime should use declared-only workspace tools
 * (no auto-injected default tool surface).
 */
export function shouldUseDeclaredOnlyLocalWorkspaceTools(env: EnvLike) {
  const value =
    env.NOLO_LOCAL_WORKSPACE_TOOLSET || env.NOLO_LOCAL_TOOLSET_MODE || "";
  return value === "declared-only" || value === "declared";
}

export function resolveGlobFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_GLOBFILES_DESCRIPTION_VARIANT,
  );
}

export function resolveListFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_LISTFILES_DESCRIPTION_VARIANT,
  );
}

export function resolveListFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_LISTFILES_PARAMETER_VARIANT,
  );
}

export function resolveReadFileDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_READFILE_DESCRIPTION_VARIANT,
  );
}

export function resolveReadFileParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_READFILE_PARAMETER_VARIANT,
  );
}

export function resolveGlobFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_GLOBFILES_PARAMETER_VARIANT,
  );
}

export function resolveSearchFilesDescriptionVariant(env: EnvLike) {
  return resolveLocalWorkspaceDescriptionVariant(
    env.NOLO_SEARCHFILES_DESCRIPTION_VARIANT,
  );
}

export function resolveSearchFilesParameterVariant(env: EnvLike) {
  return resolveLocalWorkspaceParameterVariant(
    env.NOLO_SEARCHFILES_PARAMETER_VARIANT,
  );
}

function resolveLocalWorkspaceDescriptionVariant(value: string | undefined) {
  return value === "brief" ||
    value === "strategy" ||
    value === "workflow" ||
    value === "antiShell"
    ? value
    : "strategy";
}

function resolveLocalWorkspaceParameterVariant(value: string | undefined) {
  return value === "minimal" || value === "scoped" || value === "rich"
    ? value
    : "rich";
}