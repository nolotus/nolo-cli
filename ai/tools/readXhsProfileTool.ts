/**
 * read_xhs_profile Tool
 *
 * Read-only tool for collecting XHS (Xiaohongshu) profile data:
 * anonymous public profile info and public notes visible without login.
 *
 * Anonymous-only: does not use XHS login state, cookies, or persistent profile.
 * No write actions (no like/comment/follow/collect/post/delete).
 * Cookies and xsecToken are never exposed in output.
 * Conservative by default: reads the initially loaded profile state only.
 * Extra scrolling requires explicit user intent. Direct detail/comment API
 * enrichment is disabled so reads stay close to visible desktop browsing.
 * The tool clamps extended collection unless extendedCollectionConsent is true.
 */

import { createXhsFailure } from "../../integrations/xhs-reader/types";
import type {
  XhsReadResult,
  XhsProfileCollection,
  XhsCollectionStatus,
  XhsParsedProfileUrl,
} from "../../integrations/xhs-reader/types";
import { redactXhsSensitiveValue } from "../../integrations/xhs-reader/redaction";
import { parseXhsProfileUrl } from "../../integrations/xhs-reader/url";
import { getRequestConfig, ToolApiError } from "./toolApiClient";

export const readXhsProfileFunctionSchema = {
  name: "read_xhs_profile",
  description:
    "以未登录匿名访客身份读取小红书用户主页的公开可见信息。默认只读取页面初始加载出的资料和笔记列表，不自动翻页，不抓评论或批量详情。只有当用户明确要求更多笔记/翻页时，才可显式请求一次可见页面滚动。不会使用账号、cookie 或持久浏览器 profile。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "小红书用户主页 URL，例如 https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556。用户从首页/feed 复制的 profile 链接可以带 xsec_token/xsec_source；token 只用于匿名桌面导航，输出会脱敏。",
      },
      maxScrollPages: {
        type: "number",
        description:
          "最大滚动翻页数。默认 0，即只读取页面初始加载状态；只有用户明确要求更多笔记且 extendedCollectionConsent=true 时才设置为 1 或更高。",
        default: 0,
      },
      includeComments: {
        type: "boolean",
        description:
          "是否读取匿名公开笔记详情页首屏可见评论。只有 extendedCollectionConsent=true、collectionMode=\"assisted\"、assistedAction=\"read_visible_details\" 时才会生效；不会通过直接 API 收集评论。",
        default: false,
      },
      maxCommentPagesPerNote: {
        type: "number",
        description:
          "保留兼容字段，当前固定为 1 且不会触发评论采集。",
        default: 1,
      },
      minLikesForDetail: {
        type: "number",
        description:
          "已停用：不再通过直接 API 收集笔记详情。",
      },
      minCommentsForCollect: {
        type: "number",
        description:
          "已停用：不再通过直接 API 收集评论。",
      },
      extendedCollectionConsent: {
        type: "boolean",
        description:
          "扩展采集确认开关。只有用户在本轮明确要求更多笔记、翻页、公开笔记详情或首屏评论时才可设为 true；否则必须省略或为 false。匿名模式不会采集登录后内容。",
        default: false,
      },
      collectionMode: {
        type: "string",
        enum: ["conservative", "assisted"],
        description:
          "采集模式。默认 conservative；assisted 需要 extendedCollectionConsent=true。",
        default: "conservative",
      },
      assistedAction: {
        type: "string",
        enum: ["snapshot", "read_more_notes", "read_visible_details", "discover_indexed_notes"],
        description:
          "assisted 模式下的具体动作：snapshot 只读快照，read_more_notes 最多做一次可见页面滚动，read_visible_details 匿名打开最多 3 条公开笔记页读取页面可见详情和首屏评论，discover_indexed_notes 读取外部搜索索引发现的公开笔记 URL。",
        default: "snapshot",
      },
      indexedNoteUrls: {
        type: "array",
        items: { type: "string" },
        description:
          "外部搜索索引发现的公开小红书笔记 URL（xiaohongshu.com/explore/...）。仅当 assistedAction=\"discover_indexed_notes\" 且 extendedCollectionConsent=true 时生效，最多读取 3 条；不要填搜索页 URL。",
      },
      maxAssistedSteps: {
        type: "number",
        description:
          "assisted 模式最大步数。当前固定为 1，只允许一次可见页面滚动。",
        default: 1,
        minimum: 1,
        maximum: 1,
      },
      headless: {
        type: "boolean",
        description:
          "是否用 headless 模式启动匿名浏览器。默认 false，优先打开可见桌面浏览器。",
        default: false,
      },
    },
    required: ["url"],
  },
};

type ReadXhsProfileToolContext = {
  parentMessageId?: string;
  signal?: AbortSignal;
  toolRunId?: string;
  agentKey?: string;
  userInput?: string;
  reader?: (
    options: ReadXhsProfileArgs,
  ) => Promise<XhsReadResult<XhsProfileCollection>>;
};

export interface ReadXhsProfileArgs {
  url: string;
  maxScrollPages?: number;
  includeComments?: boolean;
  maxCommentPagesPerNote?: number;
  minLikesForDetail?: number;
  minCommentsForCollect?: number;
  extendedCollectionConsent?: boolean;
  headless?: boolean;
  collectionMode?: "conservative" | "assisted";
  assistedAction?: "snapshot" | "read_more_notes" | "read_visible_details" | "discover_indexed_notes";
  maxAssistedSteps?: number;
  indexedNoteUrls?: string[];
}

export function normalizeXhsProfileReadArgs(
  args: ReadXhsProfileArgs,
): ReadXhsProfileArgs {
  const consent = args.extendedCollectionConsent === true;

  if (!consent) {
    // No consent → force conservative behavior
    return {
      ...args,
      maxScrollPages: 0,
      includeComments: false,
      maxCommentPagesPerNote: 1,
      minLikesForDetail: undefined,
      minCommentsForCollect: undefined,
      extendedCollectionConsent: false,
      collectionMode: "conservative",
      assistedAction: "snapshot",
      maxAssistedSteps: 1,
    };
  }

  // Consent granted → determine mode
  const mode = args.collectionMode === "assisted" ? "assisted" : "conservative";
  const action = args.assistedAction ?? "snapshot";
  const steps = 1;

  if (mode === "conservative") {
    // Consent alone is not enough for extended collection. The model must
    // explicitly select assisted mode so status labels match actual behavior.
    return {
      ...args,
      maxScrollPages: 0,
      includeComments: false,
      maxCommentPagesPerNote: 1,
      minLikesForDetail: undefined,
      minCommentsForCollect: undefined,
      extendedCollectionConsent: true,
      collectionMode: "conservative",
      assistedAction: "snapshot",
      maxAssistedSteps: steps,
    };
  }

  // Assisted mode with consent: clamp based on action
  let maxScrollPages = args.maxScrollPages;
  let includeComments = args.includeComments;
  let maxCommentPagesPerNote = args.maxCommentPagesPerNote;

  if (action === "read_more_notes") {
    maxScrollPages = clamp(maxScrollPages ?? steps, 1, steps);
    includeComments = false;
  } else if (action === "read_visible_details") {
    maxScrollPages = 0;
    includeComments = true;
    maxCommentPagesPerNote = 3;
  } else if (action === "discover_indexed_notes") {
    maxScrollPages = 0;
    includeComments = true;
    maxCommentPagesPerNote = 3;
  } else {
    // snapshot: no scrolling, no comments
    maxScrollPages = 0;
    includeComments = false;
    maxCommentPagesPerNote = 1;
  }

  return {
    ...args,
    maxScrollPages,
    includeComments,
    maxCommentPagesPerNote,
    minLikesForDetail: undefined,
    minCommentsForCollect: undefined,
    extendedCollectionConsent: true,
    collectionMode: mode,
    assistedAction: action,
    maxAssistedSteps: steps,
    indexedNoteUrls: action === "discover_indexed_notes"
      ? (args.indexedNoteUrls ?? []).slice(0, 3)
      : undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function assertXhsProfileUrl(url: string): XhsParsedProfileUrl {
  // Reuse parseXhsProfileUrl for validation
  try {
    return parseXhsProfileUrl(url);
  } catch {
    throw new Error(
      "read_xhs_profile 需要一个有效的小红书用户主页 URL（xiaohongshu.com/user/profile/<24位hexID>）。",
    );
  }
}

async function callLocalReadXhsProfileApi(
  thunkApi: any,
  body: object,
): Promise<XhsReadResult<XhsProfileCollection>> {
  const { currentServer, token } = getRequestConfig(thunkApi);
  const browserOrigin = (globalThis as any).window?.location?.origin;
  const baseUrl =
    typeof browserOrigin === "string" && browserOrigin
      ? browserOrigin
      : currentServer.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/read-xhs-profile`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ToolApiError(
      data?.error?.message ??
        `read_xhs_profile API 请求失败，状态码: ${response.status}`,
      {
        status: response.status,
        code: data?.error?.code,
        details: data,
      },
    );
  }
  return data as XhsReadResult<XhsProfileCollection>;
}

async function callDesktopReadXhsProfileApi(
  thunkApi: any,
  body: object,
): Promise<XhsReadResult<XhsProfileCollection>> {
  const { token } = getRequestConfig(thunkApi);
  const port = Number(process.env.NOLO_DESKTOP_SERVER_PORT ?? 3233);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    `http://127.0.0.1:${port}/api/read-xhs-profile`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ToolApiError(
      data?.error?.message ??
        `desktop read_xhs_profile API 请求失败，状态码: ${response.status}`,
      {
        status: response.status,
        code: data?.error?.code,
        details: data,
      },
    );
  }
  return data as XhsReadResult<XhsProfileCollection>;
}

async function readWithDefaultBridge(
  args: ReadXhsProfileArgs,
  thunkApi?: any,
): Promise<XhsReadResult<XhsProfileCollection>> {
  if (process.env.PLATFORM === "web") {
    if (thunkApi?.getState) {
      return callLocalReadXhsProfileApi(thunkApi, args);
    }

    if (typeof window !== "undefined" && (window as any).__NOLO_DESKTOP__) {
      try {
        const res = await fetch("/api/read-xhs-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data) {
          return data as XhsReadResult<XhsProfileCollection>;
        }
        return createXhsFailure({
          code: "network_error",
          message: `desktop read_xhs_profile endpoint failed: HTTP ${res.status}`,
        });
      } catch (error) {
        return createXhsFailure({
          code: "network_error",
          message:
            error instanceof Error
              ? error.message
              : "desktop read_xhs_profile endpoint request failed",
        });
      }
    }

    return createXhsFailure({
      code: "network_error",
      message:
        "read_xhs_profile 需要通过服务器或桌面本地 bridge 执行，不能在普通浏览器 bundle 内直接启动 Playwright。",
    });
  }

  if (process.env.NOLO_DESKTOP === "1" && thunkApi?.getState) {
    return callDesktopReadXhsProfileApi(thunkApi, args);
  }

  // Server-side: use bridge directly
  // eslint-disable-next-line react-doctor/no-eval
  const importBridge = new Function("specifier", "return import(specifier)") as <
    T = any,
  >(
    specifier: string,
  ) => Promise<T>;
  const { readXhsProfileWithBridge } = await importBridge<{
    readXhsProfileWithBridge: (
      options: ReadXhsProfileArgs,
    ) => Promise<XhsReadResult<XhsProfileCollection>>;
  }>("../../integrations/xhs-reader/bridge/readXhsProfileWithBridge.ts");
  return readXhsProfileWithBridge(args);
}

function formatDisplay(result: XhsReadResult<XhsProfileCollection>) {
  if (!result.ok) {
    const hints: string[] = [];
    if (result.code === "login_required") {
      hints.push(
        "匿名公开访问遇到登录墙：当前用户主页对未登录访客不可见，read_xhs_profile 不会请求登录或复用账号。",
      );
    } else if (result.code === "blocked") {
      hints.push(
        "匿名公开访问被安全检查拦截。请稍后重试，或接受匿名模式下无法读取该页面。",
      );
    } else if (result.code === "empty_profile_state") {
      hints.push(
        "页面加载但未获取到笔记数据。建议：确认该用户有公开笔记；如果页面需要登录，匿名模式会停止而不是切换账号。",
      );
    }
    return [
      `读取小红书用户主页失败：${result.message}`,
      `失败代码：${result.code}`,
      "",
      "可能的解决步骤：",
      "- 确认 URL 是有效的小红书用户主页链接",
      "- 如果页面只对登录用户可见，接受匿名模式无法读取该内容",
      "- 如果是临时网络或页面加载问题，可以稍后重试或增加 timeoutMs",
      "- 检查 Playwright chromium 是否已安装",
      ...hints,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const { profile, notes, noteDetails, analysis } = result.data;

  const parts: string[] = [];

  // Profile summary
  parts.push(`小红书用户: ${profile.nickname || "未命名"}`);
  if (profile.redId) parts.push(`小红书号: ${profile.redId}`);
  if (profile.ipLocation) parts.push(`IP 属地: ${profile.ipLocation}`);
  if (profile.desc) parts.push(`简介: ${profile.desc}`);

  // Interaction counts
  const ic = profile.interactionCounts;
  if (ic) {
    const counts: string[] = [];
    if (ic.follows != null) counts.push(`关注 ${ic.follows}`);
    if (ic.fans != null) counts.push(`粉丝 ${ic.fans}`);
    if (ic.likesAndCollects != null)
      counts.push(`获赞与收藏 ${ic.likesAndCollects}`);
    if (counts.length > 0) parts.push(`互动: ${counts.join(" / ")}`);
  }

  parts.push("");

  // Notes summary
  parts.push(`笔记数量: ${analysis.totalNotes}`);
  if (noteDetails.length > 0) {
    parts.push(`已获取详情: ${noteDetails.length} 篇`);
  }
  if (result.data.indexedDiscovery) {
    parts.push(
      `外部索引公开笔记: ${result.data.indexedDiscovery.verifiedNoteUrls.length}/${result.data.indexedDiscovery.acceptedNoteUrls.length} 已校验（${result.data.indexedDiscovery.requestedNoteUrls.length} 个候选）`,
    );
  }

  // Top notes
  if (analysis.highestLikedNote) {
    const n = analysis.highestLikedNote;
    parts.push(
      `最高点赞: ${n.title ?? n.noteId}（${n.count} 赞）`,
    );
  }
  if (analysis.highestCommentedNote) {
    const n = analysis.highestCommentedNote;
    parts.push(
      `最高评论: ${n.title ?? n.noteId}（${n.count} 评论）`,
    );
  }
  if (analysis.highestCollectedNote) {
    const n = analysis.highestCollectedNote;
    parts.push(
      `最高收藏: ${n.title ?? n.noteId}（${n.count} 收藏）`,
    );
  }
  if (analysis.highestSharedNote) {
    const n = analysis.highestSharedNote;
    parts.push(
      `最高分享: ${n.title ?? n.noteId}（${n.count} 分享）`,
    );
  }

  // Comment buckets
  if (analysis.commentBuckets.length > 0) {
    parts.push("");
    parts.push("评论主题分布:");
    for (const bucket of analysis.commentBuckets) {
      parts.push(`  - ${bucket.label}: ${bucket.count} 条`);
    }
  }

  // Diagnostic info (when profile succeeded but notes collection had issues)
  if (result.data.diagnostic) {
    const diag = result.data.diagnostic;
    parts.push("");
    parts.push(`⚠ 采集诊断：${diag.code}`);
    parts.push(`  ${diag.message}`);
    if (diag.loginDetected) parts.push("  检测到登录提示");
  }

  // Collection status display
  if (result.data.collectionStatus) {
    const cs = result.data.collectionStatus;
    parts.push("");
    const modeLabel = cs.mode === "assisted" ? "辅助采集" : "保守模式";
    const actionLabels: Record<string, string> = {
      snapshot: "快照",
      read_more_notes: "读取更多笔记",
      read_visible_details: "读取公开详情与首屏评论",
      discover_indexed_notes: "读取外部索引公开笔记",
    };
    parts.push(`采集模式: ${modeLabel}`);
    parts.push(`采集动作: ${actionLabels[cs.action] ?? cs.action}`);
    if (cs.mode === "assisted") {
      parts.push(
        `步数: ${cs.assistedStepCount}/${cs.limits.maxAssistedSteps}`,
      );
    }
    if (cs.nextSuggestedAction) {
      parts.push(
        `建议: ${cs.nextSuggestedAction.label} - ${cs.nextSuggestedAction.reason}`,
      );
    }
  }

  return parts.join("\n");
}

export async function readXhsProfileFunc(
  args: ReadXhsProfileArgs,
  thunkApi: any,
  context: ReadXhsProfileToolContext = {},
): Promise<{
  rawData: XhsReadResult<XhsProfileCollection>;
  displayData: string;
}> {
  const url = String(args?.url ?? "").trim();
  const parsedUrl = assertXhsProfileUrl(url);

  const readerArgs: ReadXhsProfileArgs = normalizeXhsProfileReadArgs({
    url: parsedUrl.navigationUrl,
    maxScrollPages: args.maxScrollPages,
    includeComments: args.includeComments,
    maxCommentPagesPerNote: args.maxCommentPagesPerNote,
    minLikesForDetail: args.minLikesForDetail,
    minCommentsForCollect: args.minCommentsForCollect,
    extendedCollectionConsent: args.extendedCollectionConsent,
    headless: args.headless,
    collectionMode: args.collectionMode,
    assistedAction: args.assistedAction,
    maxAssistedSteps: args.maxAssistedSteps,
    indexedNoteUrls: args.indexedNoteUrls,
  });

  const rawDataUnredacted =
    (await context.reader?.(readerArgs)) ??
    (await readWithDefaultBridge(readerArgs, thunkApi));
  const rawData = redactXhsSensitiveValue(rawDataUnredacted) as XhsReadResult<XhsProfileCollection>;

  // Build and attach collectionStatus
  if (rawData.ok) {
    rawData.data.collectionStatus = buildCollectionStatus(
      readerArgs,
      rawData.data,
    );
  }

  return {
    rawData,
    displayData: formatDisplay(rawData),
  };
}

function buildCollectionStatus(
  args: ReadXhsProfileArgs,
  data: XhsProfileCollection,
): XhsCollectionStatus {
  const mode = args.collectionMode ?? "conservative";
  const action = args.assistedAction ?? "snapshot";
  const consent = args.extendedCollectionConsent === true;
  const steps = args.maxAssistedSteps ?? 1;

  const status: XhsCollectionStatus = {
    mode,
    action,
    extendedCollectionConsent: consent,
    assistedStepCount: consent && mode === "assisted" ? steps : 0,
    limits: {
      maxAssistedSteps: steps,
      maxScrollPages: args.maxScrollPages ?? 0,
      maxCommentPagesPerNote: args.maxCommentPagesPerNote ?? 1,
      includeComments: args.includeComments ?? false,
    },
  };

  // Determine next suggested action
  status.nextSuggestedAction = computeNextSuggestedAction(args, data);

  return status;
}

function computeNextSuggestedAction(
  args: ReadXhsProfileArgs,
  data: XhsProfileCollection,
): XhsCollectionStatus["nextSuggestedAction"] {
  const { diagnostic, notes, analysis } = data;
  const action = args.assistedAction ?? "snapshot";

  if (
    (diagnostic?.loginDetected ||
      diagnostic?.code === "login_required" ||
      (diagnostic?.code === "empty_profile_state" && notes.length === 0)) &&
    action !== "discover_indexed_notes"
  ) {
    return {
      action: "discover_indexed_notes",
      label: "外部索引找公开笔记",
      reason: "站内匿名搜索不可用；可用 Google 等外部索引查找公开 note URL 后再读取可见页面",
    };
  }

  // Login wall or empty state after indexed discovery → stop; anonymous mode must not request login.
  if (diagnostic?.loginDetected || diagnostic?.code === "login_required") {
    return {
      action: "stop_anonymous_unavailable",
      label: "匿名不可见",
      reason: "检测到登录提示；匿名公开模式不会登录或复用账号",
    };
  }

  // Few notes and was a snapshot → suggest reading more notes
  if (notes.length < 5 && action === "snapshot") {
    return {
      action: "read_more_notes",
      label: "读取更多笔记",
      reason: `当前仅读取 ${notes.length} 篇笔记，可尝试翻页获取更多`,
    };
  }

  if (notes.length > 0 && action === "snapshot") {
    return {
      action: "read_visible_details",
      label: "读取公开详情与首屏评论",
      reason: "当前已有公开笔记列表，可匿名打开公开笔记页读取页面可见详情",
    };
  }

  // Analysis exists and has data → suggest saving to table
  if (analysis.totalNotes > 0 && action === "read_more_notes") {
    return {
      action: "save_to_table",
      label: "保存到表格",
      reason: "已采集到数据，可保存到表格以便分析",
    };
  }

  return undefined;
}
