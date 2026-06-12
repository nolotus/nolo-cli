import { createUserPreferenceKey } from "../../database/keys";
import {
  USER_PREFERENCE_NAMES,
  buildDefaultSpacePreferenceRegisterRecord,
  readUserPreferenceRegisterValue,
} from "../../database/userPreferenceRegister";
import { normalizeSpaceId } from "../../create/space/spaceKeys";

import { getSettingDbActionThunks } from "./dbActionThunks";

export const normalizeDefaultSpaceIdPreference = (
  value: unknown
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  if (trimmedValue === "") {
    return null;
  }

  return normalizeSpaceId(trimmedValue);
};

export const readDefaultSpaceIdPreference = async (
  dispatch: any,
  userId?: string | null
): Promise<string | null> => {
  if (!userId) {
    return null;
  }

  const registerKey = createUserPreferenceKey.defaultSpace(userId);
  const record = await dispatch(getSettingDbActionThunks().readAndWait(registerKey))
    .unwrap()
    .catch(() => null);

  return (
    normalizeDefaultSpaceIdPreference(
      readUserPreferenceRegisterValue<string>(
        record,
        USER_PREFERENCE_NAMES.DEFAULT_SPACE
      )
    ) ?? null
  );
};

export const persistDefaultSpacePreference = async (
  dispatch: any,
  userId: string,
  defaultSpaceId: string | null
) => {
  const registerKey = createUserPreferenceKey.defaultSpace(userId);
  const previousRecord = await dispatch(getSettingDbActionThunks().readAndWait(registerKey))
    .unwrap()
    .catch(() => null);

  const previousValue =
    readUserPreferenceRegisterValue<string>(
      previousRecord,
      USER_PREFERENCE_NAMES.DEFAULT_SPACE
    ) ?? null;

  if (previousRecord && previousValue === defaultSpaceId) {
    return;
  }

  await dispatch(
    getSettingDbActionThunks().write({
      customKey: registerKey,
      data: buildDefaultSpacePreferenceRegisterRecord({
        userId,
        defaultSpaceId,
        previousRecord,
      }),
    })
  ).unwrap();
};
