const FETCH_TIMEOUT = 5000;

export const fetchConvMsgs = async (
  server,
  token,
  { dialogId, dialogKey, limit, beforeKey },
  options = {}
) => {
  const { signal: externalSignal } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetch(`${server}/rpc/getConvMsgs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dialogId,
        ...(dialogKey && { dialogKey }),
        limit,
        ...(beforeKey && { beforeKey }),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);

    if (!response.ok) {
      console.error(`fetchConvMsgs: Failed ${response.status} from ${server}`);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    // Only re-throw when external signal was aborted (user navigated away)
    if (externalSignal?.aborted) {
      throw error;
    }
    console.error(`fetchConvMsgs: Error fetching from ${server}:`, error);
    return [];
  }
};
