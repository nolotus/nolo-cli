type ImagePayloadPart = Record<string, any>;

export const stripDurableImageInlinePayload = <T extends ImagePayloadPart>(
  part: T,
): T => {
  if (!part || typeof part !== "object") return part;

  const { original_data_url: _originalDataUrl, ...withoutOriginalDataUrl } =
    part;

  if (
    withoutOriginalDataUrl.type !== "image_url" ||
    !withoutOriginalDataUrl.google_native ||
    typeof withoutOriginalDataUrl.google_native !== "object"
  ) {
    return withoutOriginalDataUrl as T;
  }

  const { google_native: _googleNative, ...durablePart } =
    withoutOriginalDataUrl;
  return durablePart as T;
};
