import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { asTrimmedString } from "../../core/trimmedString";
import { callToolApi } from "./toolApiClient";

export const WEREAD_DEFAULT_SKILL_VERSION = "1.0.3";
export const WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";

export interface WereadGatewayArgs {
  api_name?: string;
  skill_version?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WereadGatewayRunOptions {
  apiKey: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export const wereadGatewayFunctionSchema = {
  name: "wereadGateway",
  description:
    "调用微信读书 Agent API Gateway。用于搜索书籍、查看书架、阅读统计、笔记划线、书评和推荐。业务参数必须平铺在请求体顶层。",
  parameters: {
    type: "object",
    properties: {
      api_name: {
        type: "string",
        description: "微信读书接口名，例如 /store/search、/shelf/sync、/user/notebooks。",
      },
      skill_version: {
        type: "string",
        description: "微信读书 skill 版本；未传时使用当前内置版本。",
      },
      params: {
        type: "object",
        description: "业务参数对象。工具会自动把字段平铺到请求体顶层，不会以 params 包裹转发。",
        additionalProperties: true,
      },
    },
    required: ["api_name"],
  } as const,
};

const RESERVED_ARG_KEYS = new Set(["api_name", "skill_version", "params"]);

function normalizeApiName(value: unknown): string {
  return asTrimmedString(value);
}

function normalizeSkillVersion(value: unknown): string {
  return asOptionalTrimmedString(value) ?? WEREAD_DEFAULT_SKILL_VERSION;
}

export function buildWereadGatewayRequestBody(args: WereadGatewayArgs): Record<string, unknown> {
  const apiName = normalizeApiName(args.api_name);
  if (!apiName) {
    throw new Error("wereadGateway 需要 api_name。");
  }

  const flattened: Record<string, unknown> = {
    ...asRecordOrEmpty(args.params),
  };
  for (const [key, value] of Object.entries(args)) {
    if (!RESERVED_ARG_KEYS.has(key)) {
      flattened[key] = value;
    }
  }

  return {
    api_name: apiName,
    ...flattened,
    skill_version: normalizeSkillVersion(args.skill_version),
  };
}

function extractUpgradeMessage(data: unknown): string | null {
  const upgradeInfo = (data as any)?.upgrade_info;
  return asOptionalTrimmedString(upgradeInfo?.message) ?? null;
}

function extractErrcode(data: unknown): number {
  const raw = (data as any)?.errcode;
  return asOptionalFiniteNumber(raw) ?? 0;
}

function extractErrorMessage(data: unknown): string {
  const record = data as any;
  return (
    asOptionalTrimmedString(record?.errmsg) ??
    asOptionalTrimmedString(record?.message) ??
    "微信读书接口返回错误"
  );
}

export async function runWereadGatewayRequest(
  args: WereadGatewayArgs,
  options: WereadGatewayRunOptions
): Promise<{ rawData: unknown; displayData: string }> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("缺少 WEREAD_API_KEY。请先在设置 -> 密钥中保存 WEREAD_API_KEY。");
  }

  const body = buildWereadGatewayRequestBody(args);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(WEREAD_GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(async () => ({
    errmsg: await response.text().catch(() => ""),
  }));
  if (!response.ok) {
    throw new Error(`微信读书接口请求失败：HTTP ${response.status}`);
  }

  const upgradeMessage = extractUpgradeMessage(data);
  if (upgradeMessage) {
    throw new Error(`微信读书 Skill 需要升级：${upgradeMessage}`);
  }

  const errcode = extractErrcode(data);
  if (errcode !== 0) {
    throw new Error(`微信读书接口返回错误 ${errcode}：${extractErrorMessage(data)}`);
  }

  const apiName = String(body.api_name);
  return {
    rawData: data,
    displayData: `微信读书接口 ${apiName} 调用成功。\n\n${JSON.stringify(data, null, 2)}`,
  };
}

export async function wereadGatewayFunc(
  args: WereadGatewayArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  return callToolApi(thunkApi, "/api/weread/gateway", args, { withAuth: true });
}
