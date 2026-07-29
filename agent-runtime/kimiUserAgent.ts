/**
 * Kimi Code 请求身份。
 *
 * Kimi Code 控制台「请求日志」的**来源**列显示的就是 User-Agent，官方 CLI 发的是
 * `kimi-code-cli/<version>`（MoonshotAI/kimi-code:
 * `apps/kimi-code/src/constant/app.ts` 的 `CLI_USER_AGENT_PRODUCT` +
 * `packages/oauth/src/identity.ts` 的 `createKimiUserAgent`，格式为
 * `${product}/${version}`，可选 ` (${suffix})`）。
 *
 * 这里**只发 User-Agent**，不发 `X-Msh-*` 设备指纹头，两个理由：
 * 1. 实测无用：OAuth bearer 与 Console API Key 两种凭证，在只带
 *    `Content-Type` + `Authorization` 的条件下，`/models`、多轮 tool-calling
 *    `/chat/completions`、SSE 流式全部 200。
 * 2. 官方自己也不发：`packages/agent-core-v2/src/kosong/model/hostRequestHeaders.ts`
 *    只对声明 `hostHeaders: 'full'` 的自家 vendor 发全套设备头，其余一律只发
 *    User-Agent —— 原文「so device identity never leaks to third-party endpoints」。
 */

/** 对齐官方 CLI 版本；升级时只改这里。 */
export const KIMI_CODE_CLI_VERSION = "0.29.2";

/**
 * 用官方格式自带的 suffix 标注实际发送方：控制台「来源」仍归到 `kimi-code-cli`
 * 一组（协议与参数完全一致），但不冒充成官方客户端本身——出问题时我们和 Kimi
 * 都能一眼定位是 nolo 发的。去掉 ` (nolo)` 即为逐字模仿，只是一行的差别。
 */
export const KIMI_CODE_USER_AGENT = `kimi-code-cli/${KIMI_CODE_CLI_VERSION} (nolo)`;

/** 请求 URL 是否指向 Kimi Code API。 */
export function isKimiEndpoint(url: string): boolean {
  return url.includes("api.kimi.com");
}

/**
 * 命中 Kimi Code 端点时返回要合并的请求头，否则返回空对象。
 * 调用方 `Object.assign(headers, kimiIdentityHeaders(url))` 即可。
 */
export function kimiIdentityHeaders(url: string): Record<string, string> {
  return isKimiEndpoint(url) ? { "User-Agent": KIMI_CODE_USER_AGENT } : {};
}
