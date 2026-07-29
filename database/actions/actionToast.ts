export type DatabaseActionToast = {
  success: (message: string) => void;
  error: (message: string) => void;
};

let registeredToast: DatabaseActionToast | null = null;

export function registerDatabaseActionToast(toast: DatabaseActionToast): void {
  registeredToast = toast;
}

export const actionToast: DatabaseActionToast = {
  success: (message) => registeredToast?.success(message),
  error: (message) => {
    if (registeredToast) registeredToast.error(message);
    else console.warn(message);
  },
};
