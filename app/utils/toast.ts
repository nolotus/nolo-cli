import type { ReactNode } from "react";
// Web toast adapter — bridges react-hot-toast API to react-aria-components ToastQueue.
// The .native.ts variant handles React Native separately.

import { queue } from "../../render/web/ui/Toast";

type ToastType = "success" | "error" | "loading" | "default";

type ToastOptions = {
  /** Timeout in milliseconds (react-hot-toast compatible) */
  timeout?: number;
  /** Alias for timeout, used by react-hot-toast callers */
  duration?: number;
  /** Toast key for updating an existing toast (react-hot-toast compatible) */
  id?: string;
  /** Custom icon (string or node) — rendered instead of the type default */
  icon?: ReactNode;
};

interface CustomToast {
  (message: ReactNode, options?: ToastOptions): string;
  success: (message: ReactNode, options?: ToastOptions) => string;
  error: (message: ReactNode, options?: ToastOptions) => string;
  loading: (message: ReactNode, options?: ToastOptions) => string;
  dismiss: (toastId?: string) => void;
}

const DEFAULT_TIMEOUT = 4000;

/**
 * Add a toast, optionally replacing an existing one with the same id.
 * react-aria-components ToastQueue has no update() method, so we close-then-add.
 */
function addToast(
  message: ReactNode,
  type: ToastType,
  options?: ToastOptions,
): string {
  // If an id is provided, close the existing toast first (loading→success pattern)
  if (options?.id) {
    queue.close(options.id);
  }

  const timeout = options?.timeout ?? options?.duration;
  const toastOptions =
    type === "loading"
      ? timeout
        ? { timeout }
        : undefined
      : { timeout: timeout ?? DEFAULT_TIMEOUT };

  return queue.add({ title: message, type, icon: options?.icon }, toastOptions);
}

const customToast = ((message: ReactNode, options?: ToastOptions) => {
  return addToast(message, "default", options);
}) as CustomToast;

customToast.success = (message: ReactNode, options?: ToastOptions) => {
  return addToast(message, "success", options);
};

customToast.error = (message: ReactNode, options?: ToastOptions) => {
  return addToast(message, "error", options);
};

customToast.loading = (message: ReactNode, options?: ToastOptions) => {
  return addToast(message, "loading", options);
};

customToast.dismiss = (toastId?: string) => {
  if (toastId) {
    queue.close(toastId);
  } else {
    queue.clear();
  }
};

export const toast = customToast;
export default customToast;