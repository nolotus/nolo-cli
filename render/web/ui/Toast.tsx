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

export type ToastType = "success" | "error" | "loading" | "default";

const TYPE_ICONS: Partial<Record<ToastType, typeof LuCheckCircle2>> = {
  success: LuCheckCircle2,
  error: LuAlertCircle,
  loading: LuLoader2,
};

interface InternalToast {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  type?: ToastType;
  icon?: ReactNode;
  timeout?: number;
  phase: "entering" | "visible" | "exiting";
}

type Listener = () => void;

// Must match the CSS transition duration (.toast-root transition) so exits
// finish before the node is removed.
const EXIT_MS = 320;

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
    type?: ToastType;
    icon?: ReactNode;
    timeout?: number;
  }): string {
    const id = item.id ?? `toast-${++this.nextId}`;
    const filtered = this.toasts.filter((t) => t.id !== id);
    const entry: InternalToast = { ...item, id, phase: "entering" };
    this.toasts = [...filtered, entry];
    this.notify();

    // entering → visible next frame; removing data-starting-style fires the
    // CSS enter transition.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.toasts = this.toasts.map((t) =>
          t.id === id ? { ...t, phase: "visible" } : t,
        );
        this.notify();
      }),
    );

    if (item.timeout && item.timeout > 0) {
      setTimeout(() => this.close(id), item.timeout);
    }

    return id;
  }

  close(id?: string) {
    if (id) {
      if (!this.toasts.some((t) => t.id === id)) return;
      this.toasts = this.toasts.map((t) =>
        t.id === id ? { ...t, phase: "exiting" } : t,
      );
    } else {
      this.toasts = this.toasts.map((t) => ({ ...t, phase: "exiting" }));
    }
    this.notify();
    setTimeout(() => {
      this.toasts = id ? this.toasts.filter((t) => t.id !== id) : [];
      this.notify();
    }, EXIT_MS);
  }

  private notify = () => {
    this.listeners.forEach((fn) => fn());
  };
}

// Module-level toast manager — usable from outside React (toast.ts adapter).
export const toastManager = new ToastStore();

function ToastItem({ toast }: { toast: InternalToast }) {
  const type = toast.type;
  const TypeIcon = type ? TYPE_ICONS[type] : undefined;
  const icon = toast.icon;

  return (
    <div
      className="toast-root"
      data-starting-style={toast.phase === "entering" ? "" : undefined}
      data-ending-style={toast.phase === "exiting" ? "" : undefined}
      data-type={type}
    >
      <div className="toast-content">
        {icon ? (
          <span className="toast-icon" aria-hidden="true">
            {icon}
          </span>
        ) : (
          TypeIcon && (
            <TypeIcon
              className={`toast-icon${type ? ` ${type}` : ""}`}
              aria-hidden="true"
            />
          )
        )}
        <div className="toast-text-wrapper">
          <div className="toast-title">{toast.title}</div>
          {toast.description && (
            <div className="toast-description">{toast.description}</div>
          )}
        </div>
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="Close"
        onClick={() => toastManager.close(toast.id)}
      >
        <LuX size={16} aria-hidden="true" />
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
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="toast-viewport">
      <ToastList />
    </div>,
    document.body,
  );
}
