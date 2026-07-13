import { createUserPreferenceKey } from "../../database/keys";
import {
  USER_PREFERENCE_NAMES,
  buildDefaultSpacePreferenceRegisterRecord,
  readUserPreferenceRegisterValue,
} from "../../database/userPreferenceRegister";
import {
  DEVICE_LOCAL_OWNER_ID,
  resolveEffectiveSpaceActorId,
} from "../../database/authority/deviceLocal";
import { normalizeSpaceId } from "../../create/space/spaceKeys";

import { getSettingDbActionThunks } from "./dbActionThunks";

/**
 * Owner id for the default-space preference register.
 * One register family only (`user-pref-{owner}-space_default`):
 * - guest / blank → `"local"`
 * - account A / B → that account userId
 * Isolation is by owner segment — never share local↔account or A↔B registers.
 */
export const resolveDefaultSpacePreferenceOwnerId = (
  userId?: string | null
): string => resolveEffectiveSpaceActorId(userId);

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
  // Always scope by effective actor so guest reads local register and
  // account A/B read only their own register (no cross-leak).
  const ownerId = resolveDefaultSpacePreferenceOwnerId(userId);

  const registerKey = createUserPreferenceKey.defaultSpace(ownerId);
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
  const ownerId = resolveDefaultSpacePreferenceOwnerId(userId);
  const registerKey = createUserPreferenceKey.defaultSpace(ownerId);
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
        userId: ownerId,
        defaultSpaceId,
        previousRecord,
      }),
    })
  ).unwrap();
};

export { DEVICE_LOCAL_OWNER_ID };
