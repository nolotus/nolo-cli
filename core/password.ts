// 子路径导入：只拉取 PBKDF2/SHA512/Base64 三个模块，避免全量 crypto-js
// 把 blowfish/tripledes/rabbit 等用不到的算法带入首屏同步 bundle。
// 输出与改前全量导入实现字节级一致（见 password.test.ts golden 断言）。
//
// crypto-js 是 CJS：
// - `crypto-js/pbkdf2` 导出 CryptoJS.PBKDF2（helper 函数），可直接调用
// - `crypto-js/enc-base64` 导出 CryptoJS.enc.Base64（编码器）
// - PBKDF2 的 hasher 选项需要算法类 CryptoJS.algo.SHA512（HasherStatic），
//   而非 `crypto-js/sha512` 导出的快捷函数 CryptoJS.SHA512（HasherHelper）。
//   `crypto-js/sha512` 加载时会把算法类注册到共享 core 的 CryptoJS.algo，
//   因此先 import 它（副作用），再从 `crypto-js/core` 取 algo.SHA512。
import PBKDF2 from "crypto-js/pbkdf2";
import Base64 from "crypto-js/enc-base64";
import "crypto-js/sha512";
import CryptoJScore from "crypto-js/core";
import { SALT, AUTH_VERSION } from ".//config";

const SHA512Algo = CryptoJScore.algo.SHA512;
// 运行时防线：crypto-js/sha512 的副作用导入负责把算法类注册到 core。
// 若该 import 被误删/tree-shake 掉，algo.SHA512 为 undefined，PBKDF2 会
// 静默回退到默认 hasher(SHA256)，导致哈希算法被悄悄换掉（auth 级事故）。
if (!SHA512Algo) {
  throw new Error(
    "crypto-js/sha512 not registered; subpath import order broken"
  );
}

export const hashPasswordV1 = async (password: string): Promise<string> => {
  const hash = PBKDF2(password, SALT, {
    keySize: 256 / AUTH_VERSION[1].keylen,
    iterations: AUTH_VERSION[1].iterations,
    hasher: SHA512Algo,
  });

  // 将 salt 和 hash 组合存储
  return hash.toString(Base64);
};
