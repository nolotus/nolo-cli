export const applyChatCompletionsStreamMode = (
  body: Record<string, any>,
  stream: boolean
): Record<string, any> => {
  const nextBody: Record<string, any> = { ...body, stream };
  if (!stream) {
    delete nextBody.stream_options;
  }
  return nextBody;
};
