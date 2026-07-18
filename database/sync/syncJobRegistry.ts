/**
 * In-flight explicit sync job registry (M5 skeleton).
 *
 * Jobs expose AbortSignal so account switch / logout can cancel account-scoped
 * work without waiting for network completion.
 */

import { asTrimmedString } from "../../core/trimmedString";

export type SyncJobRegistration = {
  id: string;
  accountUserId?: string;
  label?: string;
  startedAt: number;
  signal: AbortSignal;
};

export type RegisteredSyncJob = SyncJobRegistration & {
  abort: (reason?: unknown) => void;
};

export type RegisterSyncJobInput = {
  id?: string;
  accountUserId?: string;
  label?: string;
  /** Optional external controller; registry still owns cancel bookkeeping. */
  controller?: AbortController;
};

export type SyncJobRegistry = {
  register(input?: RegisterSyncJobInput): RegisteredSyncJob;
  get(id: string): RegisteredSyncJob | null;
  list(filter?: { accountUserId?: string }): SyncJobRegistration[];
  cancel(id: string, reason?: unknown): boolean;
  cancelByAccountUserId(accountUserId: string, reason?: unknown): number;
  cancelAll(reason?: unknown): number;
  unregister(id: string): boolean;
  size(): number;
};

type InternalJob = {
  id: string;
  accountUserId?: string;
  label?: string;
  startedAt: number;
  controller: AbortController;
  ownsController: boolean;
  onAbort: () => void;
};

const normalizeId = (value: unknown): string => asTrimmedString(value);

let nextJobSeq = 0;

const allocateJobId = (): string => {
  nextJobSeq += 1;
  return `sync-job-${nextJobSeq}`;
};

const toPublicJob = (job: InternalJob): RegisteredSyncJob => ({
  id: job.id,
  accountUserId: job.accountUserId,
  label: job.label,
  startedAt: job.startedAt,
  signal: job.controller.signal,
  abort: (reason) => {
    if (!job.controller.signal.aborted) {
      job.controller.abort(reason);
    }
  },
});

const toRegistration = (job: InternalJob): SyncJobRegistration => ({
  id: job.id,
  accountUserId: job.accountUserId,
  label: job.label,
  startedAt: job.startedAt,
  signal: job.controller.signal,
});

export function createSyncJobRegistry(options?: {
  now?: () => number;
}): SyncJobRegistry {
  const now = options?.now ?? Date.now;
  const jobs = new Map<string, InternalJob>();

  const drop = (id: string) => {
    const job = jobs.get(id);
    if (!job) return;
    job.controller.signal.removeEventListener("abort", job.onAbort);
    jobs.delete(id);
  };

  return {
    register(input = {}) {
      const requestedId = normalizeId(input.id);
      const id = requestedId || allocateJobId();
      if (jobs.has(id)) {
        throw new Error(`sync job already registered: ${id}`);
      }

      const ownsController = !input.controller;
      const controller = input.controller ?? new AbortController();
      const accountUserId = normalizeId(input.accountUserId) || undefined;
      const label = normalizeId(input.label) || undefined;

      const internal: InternalJob = {
        id,
        accountUserId,
        label,
        startedAt: now(),
        controller,
        ownsController,
        onAbort: () => {
          // Keep aborted jobs out of the active set so logout is idempotent.
          drop(id);
        },
      };

      controller.signal.addEventListener("abort", internal.onAbort, { once: true });
      if (controller.signal.aborted) {
        // Already aborted controllers never enter the active set.
        return toPublicJob(internal);
      }

      jobs.set(id, internal);
      return toPublicJob(internal);
    },

    get(id) {
      const key = normalizeId(id);
      if (!key) return null;
      const job = jobs.get(key);
      return job ? toPublicJob(job) : null;
    },

    list(filter) {
      const accountUserId = normalizeId(filter?.accountUserId);
      return Array.from(jobs.values())
        .filter((job) => {
          if (!accountUserId) return true;
          return job.accountUserId === accountUserId;
        })
        .map(toRegistration)
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt || left.id.localeCompare(right.id)
        );
    },

    cancel(id, reason) {
      const key = normalizeId(id);
      if (!key) return false;
      const job = jobs.get(key);
      if (!job) return false;
      if (!job.controller.signal.aborted) {
        job.controller.abort(reason ?? new Error("sync job cancelled"));
      } else {
        drop(key);
      }
      return true;
    },

    cancelByAccountUserId(accountUserId, reason) {
      const key = normalizeId(accountUserId);
      if (!key) return 0;
      const ids = Array.from(jobs.values())
        .filter((job) => job.accountUserId === key)
        .map((job) => job.id);
      let cancelled = 0;
      for (const id of ids) {
        if (this.cancel(id, reason)) cancelled += 1;
      }
      return cancelled;
    },

    cancelAll(reason) {
      const ids = Array.from(jobs.keys());
      let cancelled = 0;
      for (const id of ids) {
        if (this.cancel(id, reason)) cancelled += 1;
      }
      return cancelled;
    },

    unregister(id) {
      const key = normalizeId(id);
      if (!key) return false;
      if (!jobs.has(key)) return false;
      drop(key);
      return true;
    },

    size() {
      return jobs.size;
    },
  };
}

const defaultSyncJobRegistry = createSyncJobRegistry();

export function registerSyncJob(input?: RegisterSyncJobInput): RegisteredSyncJob {
  return defaultSyncJobRegistry.register(input);
}

export function getSyncJob(id: string): RegisteredSyncJob | null {
  return defaultSyncJobRegistry.get(id);
}

export function listSyncJobs(filter?: { accountUserId?: string }): SyncJobRegistration[] {
  return defaultSyncJobRegistry.list(filter);
}

export function cancelSyncJob(id: string, reason?: unknown): boolean {
  return defaultSyncJobRegistry.cancel(id, reason);
}

export function cancelSyncJobsByAccountUserId(
  accountUserId: string,
  reason?: unknown
): number {
  return defaultSyncJobRegistry.cancelByAccountUserId(accountUserId, reason);
}

/** Cancel every in-flight sync job (logout / account switch). */
export function cancelAllSyncJobs(reason?: unknown): number {
  return defaultSyncJobRegistry.cancelAll(
    reason ?? new Error("auth-scoped sync cancelled")
  );
}

export function unregisterSyncJob(id: string): boolean {
  return defaultSyncJobRegistry.unregister(id);
}

export function getDefaultSyncJobRegistry(): SyncJobRegistry {
  return defaultSyncJobRegistry;
}
