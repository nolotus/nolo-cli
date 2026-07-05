import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  LuX,
  LuCircleCheck as LuCheckCircle2,
  LuCircleAlert as LuAlertCircle,
  LuLoaderCircle as LuLoader2,
} from "react-icons/lu";
import "./Toast.css";

// ─── Types ──────────────────────────────────────────

interface ToastData {
  icon?: ReactNode;
}

type ToastType = "success" | "error" | "loading";

const TYPE_ICONS = {
  success: LuCheckCircle2,
  error: LuAlertCircle,
  loading: LuLoader2,
} as const;

interface ToastContent {
  title: ReactNode;
  description?: ReactNode;
}

interface AddOptions {
  timeout?: number;
}

// ─── Internal toast state (with animation phase) ────

interface InternalToast {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  type?: string;
  data?: ToastData;
  timeout?: number;
  phase: "entering" | "visible" | "exiting";
}

// ─── Store ──────────────────────────────────────────

type Listener = () => void;

class ToastStore {
  private toasts: InternalToast[] = [];
  private listeners = new Set<Listener>();
  private nextId = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InternalToast[] => this.toasts;

  add(item: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    type?: string;
    data?: ToastData;
    timeout?: number;
  }): string {
    const id = item.id ?? `toast-${++this.nextId}`;
    const filtered = this.toasts.filter((t) => t.id !== id);
    const entry: InternalToast = { ...item, id, phase: "entering" } as InternalToast;
    this.toasts = [...filtered, entry];
    this.notify();

    // Transition entering → visible (enter animation via data-starting-style removal)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.toasts = this.toasts.map((t) =>
          t.id === id ? { ...t, phase: "visible" } : t,
        );
        this.notify();
      });
    });

    if (item.timeout && item.timeout > 0) {
      setTimeout(() => this.close(id), item.timeout);
    }

    return id;
  }

  close(id?: string) {
    if (id) {
      this.toasts = this.toasts.map((t) =>
        t.id === id ? { ...t, phase: "exiting" } : t,
      );
      this.notify();
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
        this.notify();
      }, 200);
    } else {
      this.toasts = this.toasts.map((t) => ({ ...t, phase: "exiting" }));
      this.notify();
      setTimeout(() => {
        this.toasts = [];
        this.notify();
      }, 200);
    }
  }

  private notify = () => {
    this.listeners.forEach((fn) => fn());
  };
}

// Module-level toast manager — usable from outside React (toast.ts adapter)
export const toastManager = new ToastStore();

// Queue API compatible with the React Aria ToastQueue example.
// Example: queue.add({ title: 'Files uploaded', description: '3 files uploaded successfully.' }, { timeout: 5000 })
export const queue = {
  add(content: ToastContent, options?: AddOptions): string {
    return toastManager.add({
      title: content.title,
      description: content.description,
      timeout: options?.timeout,
    });
  },
  close(id?: string) {
    toastManager.close(id);
  },
};

// ─── React Components ────────────────────────────────

function ToastItem({ toast }: { toast: InternalToast }) {
  const type = toast.type as ToastType | undefined;
  const TypeIcon = type ? TYPE_ICONS[type] : undefined;
  const customIcon = toast.data?.icon;

  return (
    <div
      className="toast-root"
      data-starting-style={toast.phase === "entering" ? "" : undefined}
      data-ending-style={toast.phase === "exiting" ? "" : undefined}
      data-type={type ?? undefined}
    >
      <div className="toast-content">
        {(customIcon || TypeIcon) && (
          <div className="toast-icon-wrapper">
            {customIcon ?? (TypeIcon && <TypeIcon className={`toast-icon ${type ?? ""}`} />)}
          </div>
        )}
        <div className="toast-text-wrapper">
          <div className="toast-title">{toast.title}</div>
          {toast.description && <div className="toast-description">{toast.description}</div>}
        </div>
      </div>
      <button className="toast-close" aria-label="Close" onClick={() => toastManager.close(toast.id)}>
        <LuX size={16} />
      </button>
    </div>
  );
}

function ToastList() {
  const toasts = useSyncExternalStore(
    (cb) => toastManager.subscribe(cb),
    () => toastManager.getSnapshot(),
  );

  return toasts.map((item) => <ToastItem key={item.id} toast={item} />);
}

export function MyToastRegion() {
  return createPortal(
    <div className="toast-viewport">
      <ToastList />
    </div>,
    document.body,
  );
}
