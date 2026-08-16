/**
 * CLI memory recall：远程优先，本地 fallback。
 *
 * 从 agentRunCommand.ts 抽取，避免 60+ 行嵌套在 if 块里。
 * 写入已经走远程（/api/memory/remember），读取也优先走远程（/api/memory/query），
 * 这样 local/auto 模式能访问到网页端积累的记忆。
 *
 * 失败时（无认证 / 网络错误 / 远程非 ok）fallback 到本地 LevelDB。
 * 全部失败时返回 null——不阻塞对话，只省略记忆层。
 */
import { resolveMemoryRuntime } from "../ai/memory/runtime";
import { getDefaultCliLocalRuntimeDb } from "./localRuntimeDb";
import { resolveMachineId } from "../connector-experimental/machineInfo";

export interface MemoryRecallInput {
  serverUrl: string | null;
  authToken: string | null;
  agentKey: string;
  userInput: string;
  spaceId?: string;
  /** 本地运行时环境（用于获取本地 db） */
  env: Record<string, string | undefined>;
}

/**
 * 远程查询 /api/memory/query，成功返回 promptBlock，失败返回 null。
 * 独立 try/catch 保证网络错误不会跳过外层的 local fallback。
 */
const queryRemoteMemory = async (
  serverUrl: string,
  authToken: string,
  agentKey: string,
  userInput: string,
  spaceId?: string,
): Promise<string | null> => {
  try {
    const response = await fetch(`${serverUrl}/api/memory/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        agentKey,
        userInput,
        ...(spaceId ? { spaceId } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(
        "[cli-memory] remote query returned non-ok status:",
        response.status,
        "— falling back to local",
      );
      return null;
    }
    const payload = (await response.json().catch(() => null)) as
      | { promptBlock?: unknown }
      | null;
    const block =
      typeof payload?.promptBlock === "string" ? payload.promptBlock.trim() : "";
    return block || null;
  } catch (error) {
    console.warn("[cli-memory] remote query failed, falling back to local:", error);
    return null;
  }
};

const queryLocalMemory = async (
  env: Record<string, string | undefined>,
  agentKey: string,
  userInput: string,
  spaceId?: string,
): Promise<string | null> => {
  const localDb = await getDefaultCliLocalRuntimeDb({ env });
  const machineId = resolveMachineId();
  const resolution = await resolveMemoryRuntime({
    db: localDb,
    userId: machineId,
    agentKey,
    userInput,
    ...(spaceId ? { spaceId } : {}),
  });
  return resolution.promptBlock;
};

export const resolveCliMemory = async (
  input: MemoryRecallInput,
): Promise<string | null> => {
  // 1. 远程优先（有认证时）
  if (input.authToken && input.serverUrl) {
    const remoteBlock = await queryRemoteMemory(
      input.serverUrl,
      input.authToken,
      input.agentKey,
      input.userInput,
      input.spaceId,
    );
    if (remoteBlock) return remoteBlock;
  }

  // 2. 本地 fallback（无认证 / 远程失败 / 远程返回空）
  try {
    return await queryLocalMemory(
      input.env,
      input.agentKey,
      input.userInput,
      input.spaceId,
    );
  } catch (error) {
    console.warn("[cli-memory] local recall failed, omitting memory layer:", error);
    return null;
  }
};