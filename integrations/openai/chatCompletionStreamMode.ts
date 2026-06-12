export const applyChatCompletionsStreamMode = (
  body: Record<string, any>,
  stream: boolean
): Record<string, any> => {
  const nextBody = { ...body, stream };
  if (!stream) {
    delete nextBody.stream_options;
  }
  return nextBody;
};
