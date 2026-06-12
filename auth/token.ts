import { detachedSign, verifyDetachedSignature } from "../core/crypto";
import { Base64 } from "js-base64";

/**
 * Token 格式：`base64(JSON(payload)).ed25519签名`
 *
 * 设计说明：
 * - 密钥派生是确定性的：用户名 + 哈希(密码) + locale → secretKey/publicKey
 * - token 由客户端本地签发，服务端用存储的 publicKey 验签，没有中心化密钥
 * - 忘记密码 = 无法恢复（类似助记词钱包），注册时应明确告知用户
 *
 * payload 约定：
 * - userId, username 必填
 * - exp: Unix 秒（number），仅旧 token 使用；新的登录 token 默认不设置过期时间
 */

export const buildPersistentAuthTokenPayload = <T extends Record<string, unknown>>(
  payload: T,
  nowSec = Math.floor(Date.now() / 1000)
) => ({
  ...payload,
  iat: nowSec,
  nbf: nowSec,
});

export const signToken = (payload: any, secretKey: string) => {
  const encodedPayload = Base64.encode(JSON.stringify(payload));
  const signature = detachedSign(encodedPayload, secretKey);
  return `${encodedPayload}.${signature}`;
};

export const verifyToken = (token: string, publicKey: string) => {
  const [encodedPayload, signature] = token.split(".");

  if (!verifyDetachedSignature(encodedPayload, signature, publicKey)) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(Base64.decode(encodedPayload));

  // exp 统一为 Unix 秒（number），直接与当前时间比较
  if (payload.exp && typeof payload.exp === "number") {
    if (Math.floor(Date.now() / 1000) > payload.exp) {
      throw new Error("Token has expired");
    }
  }

  return payload;
};

/**
 * 不验证签名，只解析 payload。
 * 用于从 token 中快速读取 userId 等字段（如初始化 auth 状态）。
 * 注意：结果未经验签，不可用于权限判断。
 */
export const parseToken = (token: string) => {
  try {
    const [payloadBase64] = token.split(".");
    return JSON.parse(Base64.decode(payloadBase64));
  } catch {
    return null;
  }
};
