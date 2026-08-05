// packages/cli/client/localRuntimeHelpers.ts
//
// Shared helpers for local runtime adapter + remote dialog sync.
// 从 localRuntimeAdapter.ts 提取的公共依赖——避免循环 import。

import { resolvePlatformAuthToken } from "../agent-runtime/providerResolution";

export type EnvLike = Record<string, string | undefined>;

// Max wait for remote dialog-evidence sync fetches (POST write / GET read)
// before aborting, so an unreachable/hung server cannot stall a turn.
const REMOTE_DIALOG_SYNC_TIMEOUT_MS = 10000;

// Test-only override for the sync fetch timeout so suites can exercise the
// abort path without waiting the real timeout. Reset to undefined to restore.
let remoteDialogSyncTimeoutMsForTest: number | undefined;

/** Test-only: shorten the remote sync fetch timeout. */
export function setRemoteDialogSyncTimeoutForTest(ms?: number) {
  remoteDialogSyncTimeoutMsForTest = ms;
}

export function remoteDialogSyncTimeout(): number {
  return remoteDialogSyncTimeoutMsForTest ?? REMOTE_DIALOG_SYNC_TIMEOUT_MS;
}

export function resolveRuntimeServerUrl(env: EnvLike) {
  return (
    env?.NOLO_SERVER_URL ||
    env?.NOLO_SERVER ||
    env?.BASE_URL ||
    ""
  ).replace(/\/+$/, "");
}

/**
 * Resolve the effective auth token from env.
 *
 * Delegates to agent-runtime's `resolvePlatformAuthToken` so there is a single
 * source of truth for "which env vars count as a valid bearer" — previously
 * this was a second copy that drifted (it lacked BENCHMARK_AUTH_TOKEN).
 * Kept here as a thin wrapper to preserve the existing call sites and the
 * env?. tolerant access style.
 */
export function resolveRuntimeAuthToken(env: EnvLike) {
  return resolvePlatformAuthToken(env ?? {});
}