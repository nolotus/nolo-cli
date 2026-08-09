// packages/ai/tools/agent/quotaCircuitBreaker.ts
//
// 配额识别下沉共享层 + provider/agentKey 短期熔断判定（Q）。
//
// 本模块是「识别 + 判定」的单一事实来源，收敛自 packages/cli/agentRunCommand.ts
// 的 QUOTA_ERROR_PATTERNS / isQuotaExhaustedError（此前 CLI 与工具层各一份会漂移）。
//
// 硬性约束（review 重点检查）：
// - 纯逻辑、零 I/O：禁止 Node 专有 API（fs / path / child_process / process /
//   环境变量），禁止 CommonJS require；web/desktop 可直接 import。
// - 禁止读取系统时钟：所有时间由入参 `now` 传入（epoch ms），模块内不调用系统时钟 API。
// - 禁止反向依赖 CLI 包：CliProviderQuotaError 按结构化特征（name / message 前缀）
//   识别，不 import 任何 CLI 模块。
// - 解析不到的结构化字段（resetsAt / retryAfterMs）留空，不瞎猜。
//
// 存储读写不在本模块：这里只定义 CircuitBreakerStore 接口 + 一个零 I/O 内存实现，
// 各端适配层负责真正落盘（CLI 落本地文件、server 落 DB、web 走 API）。

/** quota 错误文案特征集合（单一事实来源，CLI 与工具层共用同一份）。 */
export const QUOTA_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /429/,
  /quota/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /额度/,
  /上限/,
  /用尽/,
  /CliProviderQuotaError/i,
];

/** agent 不存在错误文案特征集合（agentKey 远端 404 / 本地无配置）。 */
export const AGENT_NOT_FOUND_PATTERNS: ReadonlyArray<RegExp> = [
  /agent[^\n]{0,80}not\s+found/i,
  /agent[^\n]{0,80}not\s+exist/i,
  /agent[^\n]{0,80}不存在/i,
  /agent[^\n]{0,80}未找到/i,
  /AGENT_NOT_FOUND/,
];

/** 鉴权失败特征集合（401/403/凭证无效——与 quota 处置不同，不是换 provider 而是查 key）。 */
export const AUTH_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /401/,
  /403/,
  /unauthori[sz]ed/i,
  /authentication\s+failed/i,
  /invalid\s+(api[-\s]?key|token|credential)/i,
  /api[-\s]?key\s+(invalid|missing|not\s+found)/i,
  /token\s*(invalid|expired|失效|过期)/i,
  /未授权/,
  /认证失败/,
  /凭证/,
];

/** 网络/连接层失败特征集合（区别于 quota/auth：通常是可重试的瞬时问题）。 */
export const NETWORK_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE/i,
  /getaddrinfo|DNS\s+(error|fail)/i,
  /fetch\s+failed/i,
  /network\s+(error|unreachable|down|disconnected)/i,
  /socket\s+(hang|closed|error)/i,
  /连接失败/,
  /网络错误|网络异常|无法连接/,
];

/** run 失败的结构化 reason：quota 与普通 failed 必须可区分（quota→换执行者，failed→查代码）。 */
export type RunFailureReason =
  | "quota"
  | "agent-not-found"
  | "auth"
  | "network"
  | "other";

/** 结构化失败信息（run 记录 / 工具返回值携带的最小字段集）。 */
export interface RunFailureInfo {
  reason: RunFailureReason;
  /** 哪个 provider（如 opencode-go）；解析不到留空。 */
  provider?: string;
  /** 配额恢复前的等待时长；解析不到留空，不瞎猜。 */
  retryAfterMs?: number;
  /** 配额预计恢复时间（epoch ms）；解析不到留空。 */
  resetsAt?: number;
  /** 原始错误消息（供展示/日志，不是完整堆栈）。 */
  message?: string;
}

/** 熔断条目类型：quota 按 provider 熔断，agent-not-found 按 agentKey 负缓存。 */
export type BreakerKind = "quota" | "agent-not-found";

/** 熔断表条目（判定用最小形状；存储层可加自己的元数据字段）。 */
export interface CircuitBreakerEntry {
  /** quota → provider；agent-not-found → agentKey。 */
  target: string;
  kind: BreakerKind;
  /** 熔断截止时刻（epoch ms）。 */
  until: number;
  /** 配额预计恢复时刻（epoch ms），可选；解析不到时为空。 */
  resetsAt?: number;
}

export type CircuitBreakerTable = readonly CircuitBreakerEntry[];

/**
 * 纯函数：给定当前时间 + 熔断表 → 目标是否处于熔断期。
 * 返回命中的条目；未命中返回 undefined（= 可正常派发）。
 * 存储读写归各端适配层，本函数不做任何 I/O。
 */
export function findActiveBreaker(
  now: number,
  table: CircuitBreakerTable,
  target: string,
): CircuitBreakerEntry | undefined {
  if (!Number.isFinite(now)) return undefined;
  for (const entry of table) {
    if (entry.target !== target) continue;
    if (typeof entry.until === "number" && entry.until > now) return entry;
  }
  return undefined;
}

/**
 * 同 findActiveBreaker 的布尔封装：熔断期内应直接拒绝派发，
 * 不再发起注定失败的远程调用。
 */
export function shouldRejectDispatch(
  now: number,
  table: CircuitBreakerTable,
  target: string,
): boolean {
  return findActiveBreaker(now, table, target) !== undefined;
}

/**
 * 结构化识别 CliProviderQuotaError（不 import 其类，避免共享层反向依赖）：
 * 该错误 name 固定为 "CliProviderQuotaError"，message 带 "[QUOTA_LIMITED:<provider>]" 前缀。
 */
function isCliProviderQuotaErrorShape(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown };
  return (
    e.name === "CliProviderQuotaError" ||
    (typeof e.message === "string" && e.message.startsWith("[QUOTA_LIMITED:"))
  );
}

/** 检测 run 错误是否由配额耗尽导致（收敛自 CLI 原实现，行为保持一致）。 */
export function isQuotaExhaustedError(error: unknown): boolean {
  if (!error) return false;
  if (isCliProviderQuotaErrorShape(error)) return true;
  if (error instanceof Error) {
    return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
  }
  if (typeof error === "string") {
    return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(error));
  }
  const maybeStatus = (error as { status?: unknown }).status;
  if (typeof maybeStatus === "number" && maybeStatus === 429) return true;
  const maybeStatusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof maybeStatusCode === "number" && maybeStatusCode === 429) return true;
  return false;
}

/**
 * 检测 run 错误是否由「agent 不存在」导致（agentKey 远端 404 / 本地无配置）。
 * 保守策略：只有错误文本或 code 明确指向 agent 时才判为 agent-not-found，
 * 避免把通用 NOT_FOUND 误判成 agent 负缓存。
 */
export function isAgentNotFoundError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown };
  if (e.code === "AGENT_NOT_FOUND") return true;
  const message =
    typeof e.message === "string"
      ? e.message
      : typeof error === "string"
        ? error
        : "";
  if (AGENT_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message))) return true;
  // 纯数字 404 必须带 agent 语义文本才判 agent-not-found（避免误伤普通 404，
  // 如 "page not found" 不是 agent 问题）。纯 "not found" 文案已在 patterns 中
  // 要求 "agent ... not found" 形态，这里不再重复放行。
  if (
    (e.status === 404 || e.statusCode === 404) &&
    /agent|不存在|未找到/i.test(message)
  ) {
    return true;
  }
  return false;
}

function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    return typeof m === "string" ? m : "";
  }
  return "";
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: unknown; statusCode?: unknown };
  const s = typeof e.status === "number" ? e.status : undefined;
  const sc = typeof e.statusCode === "number" ? e.statusCode : undefined;
  return s ?? sc;
}

/**
 * 从错误文案解析配额恢复时长。
 * 支持形态（全部可选，不匹配就留空）：
 *   "Resets in 17hr 51min" / "Resets in 2 hours" / "Retry after 60 seconds" /
 *   "try again in 1 day 3 hours 45 minutes"。
 * 返回毫秒；无法解析返回 undefined（调用方不得猜测）。
 */
export function parseResetsInMs(text: string): number | undefined {
  if (!text) return undefined;
  const unitMs = (n: number, unit: string): number => {
    if (/^d/.test(unit)) return n * 24 * 3600 * 1000;
    if (/^h/.test(unit)) return n * 3600 * 1000;
    if (/^m/.test(unit)) return n * 60 * 1000;
    if (/^s/.test(unit)) return n * 1000;
    return NaN;
  };
  // 匹配 "<数字><单位>" 序列，单位支持 day/day(s)/hr/hour(s)/min/minute(s)/sec/second(s)
  const re =
    /(\d+)\s*(d(?:ay|ays)?|h(?:r|rs|our|ours)?|m(?:in|ins|inute|inutes)?|s(?:ec|ecs|econd|econds)?)/gi;
  let totalMs = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ms = unitMs(Number(m[1]), m[2]);
    if (!Number.isFinite(ms)) continue;
    totalMs += ms;
    matched = true;
  }
  return matched ? totalMs : undefined;
}

/**
 * 从错误对象提取 provider（结构化字段优先，其次解析 message 中的标记前缀）。
 * 解析不到返回 undefined。
 */
export function extractProvider(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const p = (error as { provider?: unknown }).provider;
  if (typeof p === "string" && p.length > 0) return p;
  const message = extractMessage(error);
  // CliProviderQuotaError message 形如 "[QUOTA_LIMITED:opencode-go] ..."
  const tag = /\[QUOTA_LIMITED:([^\]]+)\]/i.exec(message);
  if (tag?.[1]) return tag[1];
  return undefined;
}

/** 从错误对象读取 retry-after 响应头（秒 → 毫秒）。 */
function extractRetryAfterHeader(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  const raw = (headers as Record<string, unknown>)["retry-after"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/**
 * 把任意 run 错误分类为结构化失败信息（reason 是硬字段，其余尽力解析）。
 * 优先级：quota > agent-not-found > auth > network > other。
 */
export function classifyRunFailure(error: unknown): RunFailureInfo {
  const message = extractMessage(error);
  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterHeader(error) ?? parseResetsInMs(message);

  if (isQuotaExhaustedError(error)) {
    return {
      reason: "quota",
      provider: extractProvider(error),
      // 纯函数不取时钟：resetsAt 由调用方用 now + retryAfterMs 计算后补齐
      retryAfterMs,
      message,
    };
  }
  if (isAgentNotFoundError(error)) {
    return { reason: "agent-not-found", message };
  }
  if (isAuthError(error)) {
    return { reason: "auth", message };
  }
  if (isNetworkError(error)) {
    return { reason: "network", message };
  }
  return { reason: "other", message };
}

/** 鉴权失败判定（独立导出便于复用与测试）。 */
export function isAuthError(error: unknown): boolean {
  const message = extractMessage(error);
  const status = extractStatus(error);
  if (status === 401 || status === 403) return true;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** 网络/连接层失败判定（独立导出便于复用与测试）。 */
export function isNetworkError(error: unknown): boolean {
  const message = extractMessage(error);
  return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** 存储适配层接口：读写归各端，本层零 I/O。 */
export interface CircuitBreakerStore {
  /** 读取目标当前的熔断条目（未熔断返回 undefined）。 */
  get(target: string): CircuitBreakerEntry | undefined;
  /** 写入/更新熔断条目。 */
  set(entry: CircuitBreakerEntry): void;
  /** 显式清除某目标的熔断（即使未到期）。 */
  clear(target: string): void;
  /** 清除全部熔断记录。 */
  clearAll(): void;
}

/**
 * 零 I/O 内存实现：CLI 可直接用作轻量存储（进程内有效），
 * 需要跨进程/重启持久化的端（server 落 DB、CLI 落文件）应实现 CircuitBreakerStore。
 */
export function createInMemoryCircuitBreakerStore(): CircuitBreakerStore {
  const entries = new Map<string, CircuitBreakerEntry>();
  return {
    get(target: string): CircuitBreakerEntry | undefined {
      return entries.get(target);
    },
    set(entry: CircuitBreakerEntry): void {
      entries.set(entry.target, entry);
    },
    clear(target: string): void {
      entries.delete(target);
    },
    clearAll(): void {
      entries.clear();
    },
  };
}

/** 默认熔断时长：quota 通常按小时计（解析不到具体恢复时间时的保守兜底）。 */
export const DEFAULT_QUOTA_BREAKER_MS = 6 * 3600 * 1000;
/** agent-not-found 负缓存 TTL：短一些，避免坏 key 被长期记住。 */
export const DEFAULT_AGENT_NOT_FOUND_BREAKER_MS = 15 * 60 * 1000;

/**
 * 生成一条熔断条目（适配层在识别到失败后调用并写入自己的存储）。
 * - kind=quota：优先用解析到的 retryAfterMs，兜底 DEFAULT_QUOTA_BREAKER_MS
 * - kind=agent-not-found：用 DEFAULT_AGENT_NOT_FOUND_BREAKER_MS（TTL 短些）
 */
export function buildBreakerEntry(
  now: number,
  target: string,
  kind: BreakerKind,
  retryAfterMs?: number,
): CircuitBreakerEntry {
  const ttl =
    kind === "quota"
      ? typeof retryAfterMs === "number" && retryAfterMs > 0
        ? retryAfterMs
        : DEFAULT_QUOTA_BREAKER_MS
      : DEFAULT_AGENT_NOT_FOUND_BREAKER_MS;
  return {
    target,
    kind,
    until: now + ttl,
    ...(kind === "quota" && typeof retryAfterMs === "number" ? { resetsAt: now + retryAfterMs } : {}),
  };
}
