export const SETTINGS_RECORD_SCHEMA_VERSION = 1 as const;

export const withSettingsRecordSchema = <T extends Record<string, any>>(
  changes: T,
): T & { schemaVersion: typeof SETTINGS_RECORD_SCHEMA_VERSION } => ({
  ...changes,
  schemaVersion: SETTINGS_RECORD_SCHEMA_VERSION,
});
