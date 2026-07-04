import React from 'react';
import {
  UNSTABLE_ToastRegion as ToastRegion,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastContent as ToastContent,
  type ToastProps,
  Text
} from 'react-aria-components';
import { LuX, LuCircleCheck as LuCheckCircle2, LuCircleAlert as LuAlertCircle, LuLoaderCircle as LuLoader2 } from 'react-icons/lu'
import { flushSync } from 'react-dom';
import type { CSSProperties } from 'react';
import './Toast.css';

interface MyToastContent {
  title: React.ReactNode;
  description?: React.ReactNode;
  type?: 'success' | 'error' | 'loading' | 'default';
  icon?: React.ReactNode;
}

export const queue = new ToastQueue<MyToastContent>({
  wrapUpdate(fn) {
    if ('startViewTransition' in document) {
      (document as unknown as { startViewTransition: (cb: () => void) => void }).startViewTransition(() => {
        flushSync(fn);
      });
    } else {
      fn();
    }
  }
});

export function MyToastRegion() {
  return (
    <ToastRegion queue={queue} className="react-aria-ToastRegion">
      {({toast}) => (
        <MyToast toast={toast} style={{viewTransitionName: toast.key} as CSSProperties}>
          <ToastContent className="react-aria-ToastContent">
            <div className="toast-icon-wrapper">
              {toast.content.icon
                ? toast.content.icon
                : <>
                    {toast.content.type === 'success' && <LuCheckCircle2 className="toast-icon success" />}
                    {toast.content.type === 'error' && <LuAlertCircle className="toast-icon error" />}
                    {toast.content.type === 'loading' && <LuLoader2 className="toast-icon loading" />}
                  </>}
            </div>
            <div className="toast-text-wrapper">
              <Text slot="title">{toast.content.title}</Text>
              {toast.content.description && (
                <Text slot="description">{toast.content.description}</Text>
              )}
            </div>
          </ToastContent>
          <button
            className="react-aria-Button"
            aria-label="Close"
            onClick={() => queue.close(toast.key)}
          >
            <LuX size={16} />
          </button>
        </MyToast>
      )}
    </ToastRegion>
  );
}

export function MyToast(props: ToastProps<MyToastContent>) {
  return <Toast {...props} className="react-aria-Toast" />;
}
