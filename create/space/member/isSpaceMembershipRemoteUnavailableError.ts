/**
 * Observable membership refresh failure when configured remote membership
 * reads all fail. Boot/foreground may continue from actor-local cache only
 * for this specific code — never treat it as remote freshness.
 */
export const SPACE_MEMBERSHIP_REMOTE_UNAVAILABLE =
  "space_membership_remote_unavailable";

export const isSpaceMembershipRemoteUnavailableError = (
  error: unknown
): boolean => {
  if (typeof error === "string") {
    return error.includes(SPACE_MEMBERSHIP_REMOTE_UNAVAILABLE);
  }
  if (error instanceof Error) {
    return error.message.includes(SPACE_MEMBERSHIP_REMOTE_UNAVAILABLE);
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message.includes(
      SPACE_MEMBERSHIP_REMOTE_UNAVAILABLE
    );
  }
  return false;
};
