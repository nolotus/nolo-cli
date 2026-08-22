// 文件路径: authSlice.ts（只包含与 signUpAction 相关部分）

import {
  selectRemoteServer,
  selectRemoteSyncServers,
} from "../../app/settings/settingSlice";
import { resetAuthScopedClientState } from "../resetAuthScopedClientState";

import { verifySignedMessage } from "../../core/crypto";
import { generateUserIdV1 } from "../../core/generateMainKey";
import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { buildPersistentAuthTokenPayload, signToken, parseToken } from "../token";
import { API_VERSION } from "../../database/config";
import { hashPasswordV1 } from "../../core/password";
import { generateKeyPairFromSeedV1 } from "../../core/generateKeyPairFromSeedV1";
import { getAllServers } from "../../database/actions/common";

const TIMEOUT = 5000;

type SignUpSendData = {
  username: string;
  publicKey: string;
  locale: string;
  email?: string;
  inviterId?: string;
  clientIp?: string | null;
};

const getSignUpErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload?.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    // Fall back to plain text below.
  }

  try {
    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    // Ignore text parsing errors and use the status fallback.
  }

  return `注册失败，服务器响应状态码：${response.status}`;
};

// 获取客户端公网 IP（失败时返回 null，不阻塞注册流程）
const getPublicIp = async (): Promise<string | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);

    const res = await fetch("https://api.ipify.org?format=json", {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();
    return data?.ip || null;
  } catch {
    return null;
  }
};

const signUpToServer = async (
  server: string,
  sendData: SignUpSendData,
  nolotusPubKey: string,
  signal?: AbortSignal
) => {
  const response = await fetch(`${server}${API_VERSION}/users/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sendData?.clientIp
        ? { "X-Client-IP": String(sendData.clientIp) }
        : {}),
    },
    body: JSON.stringify(sendData),
    signal,
  });

  if (!response.ok) {
    throw new Error(await getSignUpErrorMessage(response));
  }

  const { encryptedData } = await response.json();
  const decryptedData = await verifySignedMessage(
    encryptedData,
    nolotusPubKey
  );
  const result = JSON.parse(decryptedData);
  return result;
};

const signUpToBackupServers = (
  servers: string[],
  sendData: SignUpSendData,
  nolotusPubKey: string
) => {
  servers.forEach((server) => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      TIMEOUT
    );

    signUpToServer(server, sendData, nolotusPubKey, abortController.signal)
      .then((result) => {
        clearTimeout(timeoutId);
        if (!result) {
          // 备份注册失败时，此处可按需记录日志或上报
        }
      })
      .catch(() => {
        clearTimeout(timeoutId);
      });
  });
};

export const signUpAction = async (user: any, thunkAPI: any) => {
  const { username, locale, password, email, inviterId } = user;
  const state = thunkAPI.getState();
  const tokenManager = thunkAPI.extra.tokenManager;

  // 1) 本地生成密钥对
  const encryptionKey = await hashPasswordV1(password);
  const { publicKey, secretKey } = generateKeyPairFromSeedV1(
    username + encryptionKey + locale
  );

  // 2) 获取客户端公网 IP（失败则为 null）
  const clientIp = await getPublicIp();

  const sendData: SignUpSendData = {
    username,
    publicKey,
    locale,
    email,
    inviterId,
    clientIp,
  };

  const nolotusPubKey = "pqjbGua2Rp-wkh3Vip1EBV6p4ggZWtWvGyNC37kKPus";

  const currentServer = selectRemoteServer(state);
  const configuredSyncServers = selectRemoteSyncServers(state) ?? [];

  // 3) 先在当前 server 上完成主注册
  //    使用 getAllServers 只传当前服务器，做一次规范化 + 在线判断
  const mainServers = getAllServers(currentServer, []);
  const mainServer = mainServers[0];

  if (!mainServer) {
    throw new Error("No available server for sign up (possibly offline).");
  }

  const mainAbortController = new AbortController();
  const mainTimeoutId = setTimeout(() => mainAbortController.abort(), TIMEOUT);
  let remoteData: any;
  try {
    remoteData = await signUpToServer(
      mainServer,
      sendData,
      nolotusPubKey,
      mainAbortController.signal
    );
  } finally {
    clearTimeout(mainTimeoutId);
  }

  if (!remoteData) {
    throw new Error("Failed to register on current server");
  }

  // 4) 本地重新计算 userId，校验服务端回包一致性
  const localUserId = generateUserIdV1(publicKey, username, locale);
  const isValid =
    remoteData.publicKey === publicKey &&
    remoteData.username === username &&
    remoteData.userId === localUserId;

  if (!isValid) {
    throw new Error("Server data does not match local data");
  }

  // 5) 异步向备份服务器同步注册
  //    - 仅使用 settings.syncServers（去掉 currentServer）
  //    - 使用 getAllServers(undefined, syncServers) 做去重和 URL 规范化
  const backupCandidates = getAllServers(undefined, configuredSyncServers);
  const backupServers = backupCandidates.filter((s) => s !== mainServer);

  if (backupServers.length > 0) {
    Promise.resolve().then(() => {
      signUpToBackupServers(backupServers, sendData, nolotusPubKey);
    });
  }

  // 6) 生成本地登录 token
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signToken(
    buildPersistentAuthTokenPayload(
      {
        userId: localUserId,
        username,
        publicKey,
        tokenVersion: Math.max(
          0,
          Math.floor(asOptionalFiniteNumber(remoteData.tokenVersion) ?? 0)
        ),
      },
      nowSec
    ),
    secretKey
  );
  await resetAuthScopedClientState(thunkAPI.dispatch);
  await tokenManager.storeToken(token);
  const parsedUser = parseToken(token);

  return { user: parsedUser, token };
};
