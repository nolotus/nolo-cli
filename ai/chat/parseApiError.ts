// 处理失败的API响应
export async function parseApiError(response: Response): Promise<string> {
  const errorBody = await response.text();
  const truncateErrorMessage = (message: string, maxChars = 320): string =>
    message.length <= maxChars ? message : `${message.slice(0, maxChars)}…`;
  const isContextOverflow = (message: string): boolean =>
    /maximum context length|context length|context_length_exceeded|requested about .*tokens|too many tokens/i.test(message);
  let defaultMessage = `状态码 ${response.status} ${response.statusText}`;
  let errorMessage = defaultMessage;
  let errorCode: string | null = `E${response.status}`;

  try {
    const errorJson = JSON.parse(errorBody);
    errorMessage = errorJson?.error?.message
      || errorJson?.message
      || errorJson?.msg
      || errorBody
      || defaultMessage;
    errorCode = errorJson?.error?.code || errorJson?.code || errorCode;
  } catch (_e) {
    if (errorBody) {
      errorMessage = errorBody;
    }
  }

  switch (response.status) {
    case 400:
      if (isContextOverflow(errorMessage) || isContextOverflow(errorBody) || errorCode === "UPSTREAM_400") {
        return "上下文过长：本轮消息或工具结果太大。请缩小范围，或先读取更小片段后再继续。";
      }
      if (errorCode === "MISSING_PROVIDER_API_KEY") {
        return truncateErrorMessage(errorMessage);
      }
      if (errorMessage && errorMessage !== defaultMessage) {
        return `请求参数错误: ${truncateErrorMessage(errorMessage)}`;
      }
      return "请求参数错误，请检查输入";
    case 413:
      return "请求内容过大：请减少一次发送的消息、文件或工具结果。";
    case 401:
      switch (errorCode) {
        case "AUTH_TOKEN_EXPIRED":
          return "登录状态已过期，请先登出后重新登录";
        case "AUTH_ACCOUNT_INVALID":
          return "账户无效或已被停用，请联系管理员";
        case "AUTH_NO_TOKEN":
          return "未检测到登录状态，请先登录";
        case "AUTH_INVALID_TOKEN":
          return "登录凭证无效，请先登出后重新登录";
        case "AUTH_TOKEN_NOT_ACTIVE":
          return "令牌尚未生效，请稍后再试";
        default:
          // 避免把第三方 API 的 401（如 OpenRouter key 缺失）误显示为"请先登出重登"
          return errorMessage && errorMessage !== `状态码 401 Unauthorized`
            ? `认证错误: ${truncateErrorMessage(errorMessage)}`
            : "身份验证失败，请先登出后重新登录";
      }
    case 503:
      return errorMessage && errorMessage !== `状态码 503 Service Unavailable`
        ? truncateErrorMessage(errorMessage)
        : "服务暂时不可用，请稍后再试";
    case 504:
      return "请求超时，请稍后再试";
    default:
      return `API请求失败: ${truncateErrorMessage(errorMessage)}`;
  }
}
