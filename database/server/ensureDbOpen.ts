export type DbWithOpenStatus = {
  status?: string | null;
  open?: () => Promise<unknown>;
};

export async function ensureDbOpen(db: DbWithOpenStatus) {
  if (db.status === "open") {
    return;
  }

  if (typeof db.open === "function") {
    await db.open();
  }
}
