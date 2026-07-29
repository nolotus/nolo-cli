import type { ReactNode } from "react";
// Web toast adapter — react-hot-toast style API, backed by render/web/ui/Toast.
// The .native.ts variant handles React Native separately.

import { toastManager, type ToastType } from "../../render/web/ui/Toast";

type ToastOptions = {
  /** Auto-dismiss timeout in ms (react-hot-toast alias `duration` supported) */
  timeout?: number;
  duration?: number;
  /** Toast key — reusing an id updates the existing toast in place */
  id?: string;
  /** Custom icon node — overrides the type default */
  icon?: ReactNode;
};

const DEFAULT_TIMEOUT = 4000;

function add(
  message: ReactNode,
  type: ToastType,
  options?: ToastOptions,
): string {
  const timeout = options?.timeout ?? options?.duration;
  return toastManager.add({
    id: options?.id,
    title: message,
    type,
    icon: options?.icon,
    // loading toasts stay until explicitly replaced/closed (timeout=0)
    timeout: type === "loading" ? (timeout ?? 0) : (timeout ?? DEFAULT_TIMEOUT),
  });
}

export const toast = Object.assign(
  (message: ReactNode, options?: ToastOptions) =>
    add(message, "default", options),
  {
    success: (message: ReactNode, options?: ToastOptions) =>
      add(message, "success", options),
    error: (message: ReactNode, options?: ToastOptions) =>
      add(message, "error", options),
    loading: (message: ReactNode, options?: ToastOptions) =>
      add(message, "loading", options),
    dismiss: (id?: string) => toastManager.close(id),
  },
);

export default toast;
