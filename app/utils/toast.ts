import type { ReactNode } from "react";
// Web toast adapter — reacts-toast style API, backed by render/web/ui/Toast.
// The .native.ts variant handles React Native separately.

import { toastManager } from "../../render/web/ui/Toast";

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
 * Uses upsert semantics — add with existing id updates in place.
 */
function addToast(
  message: ReactNode,
  type: ToastType,
  options?: ToastOptions,
): string {
  const id = options?.id;
  const timeout = options?.timeout ?? options?.duration;
  // loading toasts: no auto-dismiss (timeout=0) unless explicit timeout given
  const finalTimeout = type === "loading"
    ? (timeout ?? 0)
    : (timeout ?? DEFAULT_TIMEOUT);

  return toastManager.add({
    id,
    title: message,
    type,
    data: { icon: options?.icon },
    timeout: finalTimeout,
  });
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

customToast.dismiss = (toastId?: string) => toastManager.close(toastId);

export const toast = customToast;
export default customToast;
