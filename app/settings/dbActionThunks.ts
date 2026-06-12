import * as databaseDbActionThunks from "../../database/dbActionThunks";

const getDefaultSettingDbActionThunks = () => ({
  readAndWait: databaseDbActionThunks.readAndWait,
  patch: databaseDbActionThunks.patch,
  upsert: databaseDbActionThunks.upsert,
  write: databaseDbActionThunks.write,
});

type SettingDbActionThunks = ReturnType<typeof getDefaultSettingDbActionThunks>;

const settingDbActionThunksOverrideKey = Symbol.for(
  "bun-nolo.app.settings.dbActionThunksOverride"
);

export const getSettingDbActionThunks = (): SettingDbActionThunks => {
  const globalOverride = (globalThis as Record<PropertyKey, unknown>)[
    settingDbActionThunksOverrideKey
  ];
  return (
    (globalOverride as SettingDbActionThunks | undefined) ??
    getDefaultSettingDbActionThunks()
  );
};

export const setSettingDbActionThunksForTests = (
  override: SettingDbActionThunks | null
) => {
  if (override) {
    (globalThis as Record<PropertyKey, unknown>)[settingDbActionThunksOverrideKey] = override;
    return;
  }
  delete (globalThis as Record<PropertyKey, unknown>)[settingDbActionThunksOverrideKey];
};
