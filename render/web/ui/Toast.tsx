import type { ReactNode } from 'react';
import { Toast } from '@base-ui/react/toast';
import { LuX, LuCircleCheck as LuCheckCircle2, LuCircleAlert as LuAlertCircle, LuLoaderCircle as LuLoader2 } from 'react-icons/lu'
import './Toast.css';

interface ToastData {
  icon?: ReactNode;
}

const TYPE_ICONS = {
  success: LuCheckCircle2,
  error: LuAlertCircle,
  loading: LuLoader2,
} as const;

// Module-level toast manager — usable from outside React (toast.ts adapter)
export const toastManager = Toast.createToastManager<ToastData>();

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => {
    const type = item.type as keyof typeof TYPE_ICONS | undefined;
    const TypeIcon = type ? TYPE_ICONS[type] : undefined;
    return (
      <Toast.Root key={item.id} toast={item} className="toast-root">
        <Toast.Content className="toast-content">
          <div className="toast-icon-wrapper">
            {item.data?.icon ?? (TypeIcon && <TypeIcon className={`toast-icon ${type}`} />)}
          </div>
          <div className="toast-text-wrapper">
            <Toast.Title className="toast-title" />
            {item.description && <Toast.Description className="toast-description" />}
          </div>
          <Toast.Close className="toast-close">
            <LuX size={16} />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    );
  });
}

export function MyToastRegion() {
  return (
    <Toast.Provider toastManager={toastManager}>
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
