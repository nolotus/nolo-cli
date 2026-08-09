/**
 * app 命令组的共享层——薄 re-export。
 * 通用工具已提升到 packages/cli/cliApiClient.ts 和 cliOutputHelpers.ts，
 * 供所有 CLI 命令组复用。本文件保留 app 专属的类型和 re-export 以减少命令文件的 import 长度。
 */
import { hasFlag, hasHelpArg } from "./docCommandShared";
import { readOption } from "./cliEnvHelpers";

export type AppCommandDeps = { env: NodeJS.ProcessEnv };

// 通用 API 请求 + 错误 + 鉴权上下文
export {
  cliApiRequest,
  printCliError,
  resolveCliContext,
  CliApiError,
  type CliApiRequestArgs,
} from "./cliApiClient";

// 通用输出工具
export { pickDefined, formatFields, outputResult } from "./cliOutputHelpers";

// 参数解析原语（re-export 方便命令文件统一从一个地方 import）
export { hasFlag, hasHelpArg, readOption };