export const normalizeServerOrigin = (base: string): string | null => {
  try {
    return new URL(base).origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
};
