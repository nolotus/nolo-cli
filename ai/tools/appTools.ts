// packages/ai/tools/appTools.ts
// Web 应用部署/管理工具
// 当前统一发布到平台托管运行时

import { toErrorMessage } from "../../core/errorMessage";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { toolRunUpdated, type ToolRunStep } from "./toolRunSlice";
import { callToolApi, getToolRequestContext } from "./toolApiClient";
import { syncAppRecord } from "../../app/actions/syncAppRecord";
import { deleteDbKey } from "../../app/hooks/deleteDbKey";
import { selectAllMsgs, selectCurrentDialogId } from "../../chat/messages/messageSlice";
import { ToolResultError } from "./toolResultError";
import {
  analyzeAppStyleSystem,
  buildAppReadSnapshotWarning,
  buildAppStyleSystemHint,
  classifyAppReadSnapshot,
} from "./appReadSnapshot";
import { evaluateSmallVisualEditGuard } from "./appEditGuard";

type AppSourceFile = { name: string; code: string };
type AppDeployFramework = "worker" | "react-spa" | "nolo-react";

interface AppDeployArgs {
  name?: string;
  code?: string;
  files?: AppSourceFile[];
  pages?: AppSourceFile[];
  appId?: string;
  framework?: AppDeployFramework;
  spaceId?: string;
}

interface AppDeployApiResult {
  success: boolean;
  url: string;
  customUrl?: string;
  routeRegistered?: boolean;
  previewReady?: boolean;
  modifiedOn?: string;
  userFriendlyName: string;
  appId?: string;
  appKey?: string;
  appRecord?: Record<string, any> | null;
  bundleWarnings?: string[];
  deployMode?: "platform";
  framework?: AppDeployFramework;
  previewCheck?: {
    attempted: boolean;
    ready: boolean;
    status?: number;
    attempts: number;
  };
}

interface AppDeployStartResult {
  success: boolean;
  jobId: string;
  eventChannel?: string;
  status: "pending" | "running";
  summary?: string;
  steps?: ToolRunStep[];
}

interface AppDeployStatusResult {
  success: boolean;
  jobId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  summary?: string;
  steps?: ToolRunStep[];
  result?: AppDeployApiResult;
  error?: {
    message?: string;
    code?: string;
    details?: unknown;
  };
}

interface AppPreflightIssue {
  code: string;
  message: string;
  file?: string;
  importSpecifier?: string;
  symbol?: string;
  suggestion?: string;
}

interface AppPreflightResult {
  success: boolean;
  ok: boolean;
  framework: AppDeployFramework;
  summary: string;
  issues: AppPreflightIssue[];
  warnings: string[];
  entryFile?: string;
  externalImports?: string[];
}

interface AppRepairPlanStep {
  action: string;
  reason: string;
}

interface AppRepairPlan {
  strategy: "targeted-repair";
  scope: "existing-files";
  mode: "preflight-first";
  summary: string;
  steps: AppRepairPlanStep[];
  issueCodes: string[];
  suggestedFiles?: string[];
  keepFiles?: string[];
  revertFiles?: string[];
  preferTokenFiles?: string[];
  targetStyleFields?: string[];
  targetElements?: string[];
  rerun: ["appPreflight", "appDeploy"];
}

interface AppStoplossPayload {
  success: false;
  ok: false;
  error: true;
  code:
    | "DEPLOY_TRANSPORT_FAILURE"
    | "PREFLIGHT_TRANSPORT_FAILURE";
  summary: string;
  framework: AppDeployFramework;
  stopReason: "invalid-json-response" | "html-response";
  retryable: false;
  responsePreview?: string;
  nextAction: string;
}

export function decideAppDeploySpaceId(params: {
  explicitSpaceId?: string | null;
  currentSpaceId?: string | null;
  existingAppSpaceId?: string | null;
}): string | undefined {
  const existingAppSpaceId = asOptionalTrimmedString(params.existingAppSpaceId);
  if (existingAppSpaceId) {
    return undefined;
  }
  return (
    asOptionalTrimmedString(params.explicitSpaceId) ??
    asOptionalTrimmedString(params.currentSpaceId)
  );
}

export async function resolveAppDeploySpaceId(
  args: AppDeployArgs,
  thunkApi: any
): Promise<string | undefined> {
  const state = thunkApi?.getState?.();
  const rawSpaceId = state?.space?.viewMode === "all" ? null : state?.space?.currentSpaceId;
  const currentSpaceId = asOptionalTrimmedString(rawSpaceId);

  if (!args.appId) {
    return decideAppDeploySpaceId({
      explicitSpaceId: args.spaceId,
      currentSpaceId,
    });
  }

  try {
    const existing = await callToolApi<{
      success: boolean;
      spaceId?: string | null;
    }>(thunkApi, "/api/app/get", { appId: args.appId }, { withAuth: true });

    return decideAppDeploySpaceId({
      explicitSpaceId: args.spaceId,
      currentSpaceId,
      existingAppSpaceId: existing.spaceId,
    });
  } catch {
    return decideAppDeploySpaceId({
      explicitSpaceId: args.spaceId,
      currentSpaceId,
    });
  }
}

const TOOL_STEP_STATUS_RANK: Record<ToolRunStep["status"], number> = {
  pending: 0,
  running: 1,
  succeeded: 2,
  failed: 3,
};

function parseSseChunk(chunk: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice(5).trim();
    if (!json) continue;
    try {
      results.push(JSON.parse(json));
    } catch {
      // ignore malformed lines / heartbeat
    }
  }
  return results;
}

const APP_DEPLOY_STEP_LABELS: Record<string, string> = {
  prepare: "整理部署参数",
  preflight: "预检代码",
  build: "打包应用",
  deploy: "发布站点",
  verify: "验证访问",
};

function buildDeploySteps(
  currentStepId: keyof typeof APP_DEPLOY_STEP_LABELS,
  currentStatus: ToolRunStep["status"],
  detail?: string
): ToolRunStep[] {
  const ids = Object.keys(APP_DEPLOY_STEP_LABELS) as Array<
    keyof typeof APP_DEPLOY_STEP_LABELS
  >;
  const currentIndex = ids.indexOf(currentStepId);
  return ids.map((id, index) => ({
    id,
    label: APP_DEPLOY_STEP_LABELS[id],
    status:
      index < currentIndex
        ? "succeeded"
        : index === currentIndex
          ? currentStatus
          : "pending",
    ...(index === currentIndex && detail ? { detail } : {}),
  }));
}

function updateDeployProgress(
  thunkApi: any,
  toolRunId: string | undefined,
  stepIdOrSteps: keyof typeof APP_DEPLOY_STEP_LABELS | ToolRunStep[],
  summary: string,
  currentStatus: ToolRunStep["status"] = "running",
  detail?: string
) {
  if (!toolRunId) return;
  thunkApi.dispatch(
    toolRunUpdated({
      id: toolRunId,
      outputSummary: summary,
      steps: Array.isArray(stepIdOrSteps)
        ? stepIdOrSteps
        : buildDeploySteps(stepIdOrSteps, currentStatus, detail),
    })
  );
}

function normalizeAppDeployArgs(args: AppDeployArgs) {
  const normalizedFiles = Array.isArray(args.files) && args.files.length > 0
    ? args.files
    : Array.isArray(args.pages) && args.pages.length > 0
      ? args.pages
      : undefined;
  return {
    ...args,
    files: normalizedFiles,
  };
}

function isLikelyReactWorkerMisuse(code: string | undefined): boolean {
  if (!code) return false;
  return /from\s+["']react["']|from\s+["']react-dom|react-icons\/lu|createRoot\s*\(|<\w+[^>]*>/.test(
    code
  );
}

function rewriteAppDeployError(errorMessage: string, args: AppDeployArgs): string {
  if (errorMessage.includes("React SPA 模式必须提供 files 参数")) {
    return 'React SPA 需要传 `files`（至少 `main.tsx` + `App.tsx`），不能只传 `code`。如果你现在拿到的是多文件源码，也可以直接传 `pages`，系统会自动兼容为 `files`。';
  }
  if (errorMessage.includes("需要提供 code 或 files 参数")) {
    return "缺少可部署源码。请传 `code`（单文件 Worker）或 `files`（多文件项目）；如果你手上字段名是 `pages`，现在也可以直接传。";
  }
  if (
    errorMessage.includes("Bundle failed") &&
    args.framework !== "react-spa" &&
    isLikelyReactWorkerMisuse(args.code)
  ) {
    return '检测到你把 React 组件代码当成单文件 Worker 去部署了。要做交互网页，请改用 `framework: "react-spa"` 并传 `files`（通常是 `main.tsx` + `App.tsx`）；如果你只想返回静态 HTML，请去掉 `react` / `react-dom` / `react-icons` import。';
  }
  return errorMessage;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : ""
      )
      .join("\n");
  }
  return "";
}

function getLatestUserInputFromThunk(thunkApi: any): string | undefined {
  try {
    const state = thunkApi?.getState?.();
    if (!state) return undefined;
    const dialogId = selectCurrentDialogId(state);
    const messages = selectAllMsgs(state, dialogId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      const text = messageContentToText(message.content).trim();
      if (text) return text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function formatPreflightIssues(issues: AppPreflightIssue[] | undefined): string {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  return issues
    .slice(0, 6)
    .map((issue) => {
      const parts = [`- ${issue.message}`];
      if (issue.suggestion) parts.push(`建议改为：${issue.suggestion}`);
      return parts.join("；");
    })
    .join("\n");
}

function inferRepairSuggestedFiles(issues: AppPreflightIssue[] | undefined): string[] {
  const files = new Set<string>();
  for (const issue of issues ?? []) {
    if (issue.file) files.add(issue.file);
    if (issue.code === "missing-entry-file") {
      files.add("main.tsx");
      files.add("App.tsx");
    }
  }
  return [...files];
}

function buildRepairSteps(
  issues: AppPreflightIssue[] | undefined,
  framework: AppDeployFramework
): AppRepairPlanStep[] {
  const steps: AppRepairPlanStep[] = [];
  const seen = new Set<string>();

  const push = (action: string, reason: string) => {
    const key = `${action}::${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ action, reason });
  };

  for (const issue of issues ?? []) {
    switch (issue.code) {
      case "missing-files":
        push(
          framework === "react-spa"
            ? "补齐 React SPA 的 files 数组，不要只传 code"
            : "补齐可部署源码，确保至少传 code 或 files",
          issue.message
        );
        break;
      case "missing-entry-file":
        push("新增并保留稳定入口文件 main.tsx 与 App.tsx", issue.message);
        break;
      case "invalid-file":
      case "invalid-file-path":
        push("修正非法文件名或空文件内容，只改出问题的文件", issue.message);
        break;
      case "css-import-disallowed":
        push("移除 CSS import，改成内联样式、style 对象或组件内 style 标签", issue.message);
        break;
      case "unsupported-import":
        push(
          issue.importSpecifier
            ? `移除或替换未支持依赖 ${issue.importSpecifier}，只保留平台白名单依赖`
            : "移除或替换未支持依赖，只保留平台白名单依赖",
          issue.message
        );
        break;
      case "invalid-icon-import":
        push(
          issue.suggestion
            ? `把无效图标替换成 ${issue.suggestion}`
            : "把无效图标替换成 react-icons/lu 中真实存在的图标名",
          issue.message
        );
        break;
      default:
        push("根据预检问题做局部修复，不要整页重写", issue.message);
    }
  }

  push("修完后先重新调用 appPreflight", "确认当前 issues 已消除");
  push("只有 preflight 通过后再调用 appDeploy", "避免重复进入失败部署");
  return steps;
}

function buildAppRepairPlan(args: {
  summary: string;
  framework: AppDeployFramework;
  issues?: AppPreflightIssue[];
}): AppRepairPlan {
  return {
    strategy: "targeted-repair",
    scope: "existing-files",
    mode: "preflight-first",
    summary: args.summary,
    steps: buildRepairSteps(args.issues, args.framework),
    issueCodes: [...new Set((args.issues ?? []).map((issue) => issue.code))],
    suggestedFiles: inferRepairSuggestedFiles(args.issues),
    rerun: ["appPreflight", "appDeploy"],
  };
}

function buildAppRepairPayload(args: {
  summary: string;
  framework: AppDeployFramework;
  issues?: AppPreflightIssue[];
  warnings?: string[];
  entryFile?: string;
  externalImports?: string[];
  code?: string;
}): {
  success: false;
  ok: false;
  error: true;
  code: "PREFLIGHT_FAILED" | "DEPLOY_FAILED";
  summary: string;
  framework: AppDeployFramework;
  issues: AppPreflightIssue[];
  warnings?: string[];
  entryFile?: string;
  externalImports?: string[];
  repairPlan: AppRepairPlan;
  nextAction: string;
} {
  const issues = args.issues ?? [];
  return {
    success: false,
    ok: false,
    error: true,
    code: issues.length > 0 ? "PREFLIGHT_FAILED" : "DEPLOY_FAILED",
    summary: args.summary,
    framework: args.framework,
    issues,
    ...(args.warnings?.length ? { warnings: args.warnings } : {}),
    ...(args.entryFile ? { entryFile: args.entryFile } : {}),
    ...(args.externalImports?.length ? { externalImports: args.externalImports } : {}),
    repairPlan: buildAppRepairPlan({
      summary: args.summary,
      framework: args.framework,
      issues,
    }),
    nextAction:
      "只修复当前 issues 命中的文件和依赖，然后重新调用 appPreflight；只有通过后再 appDeploy。",
  };
}

function formatRepairPlan(plan: AppRepairPlan | undefined): string {
  if (!plan) return "";
  return [
    "修复建议：",
    ...plan.steps.slice(0, 6).map((step, index) => `${index + 1}. ${step.action}（${step.reason}）`),
    ...(plan.keepFiles?.length ? [`- 保留文件：${plan.keepFiles.join(", ")}`] : []),
    ...(plan.revertFiles?.length ? [`- 回退文件：${plan.revertFiles.join(", ")}`] : []),
    ...(plan.preferTokenFiles?.length
      ? [`- 优先把视觉修改收敛到这些 token 文件：${plan.preferTokenFiles.join(", ")}`]
      : []),
    ...(plan.targetStyleFields?.length
      ? [`- 仅继续调整这些视觉字段：${plan.targetStyleFields.join(", ")}`]
      : []),
    ...(plan.targetElements?.length
      ? [`- 仅继续调整这些元素：${plan.targetElements.join(", ")}`]
      : []),
    "修完后：先 appPreflight，再 appDeploy。",
  ].join("\n");
}

function isTransportStoplossError(error: {
  code?: string;
  message?: string;
  details?: unknown;
} | null | undefined): boolean {
  const code = error?.code ?? "";
  if (
    code === "HTML_RESPONSE" ||
    code === "INVALID_JSON_RESPONSE" ||
    code === "HTML_ERROR_RESPONSE" ||
    code === "NON_JSON_ERROR_RESPONSE"
  ) {
    return true;
  }
  const message = error?.message ?? "";
  return message.includes("Unexpected token '<'") || message.includes("<!DOCTYPE");
}

function buildAppStoplossPayload(args: {
  summary: string;
  framework: AppDeployFramework;
  stage: "deploy" | "preflight";
  error?: {
    code?: string;
    details?: unknown;
    message?: string;
  } | null;
}): AppStoplossPayload {
  const details =
    args.error?.details && typeof args.error.details === "object"
      ? (args.error.details as { responsePreview?: string })
      : null;
  const errorCode = args.error?.code ?? "";
  const stopReason =
    errorCode.includes("HTML") || (args.error?.message ?? "").includes("<!DOCTYPE")
      ? "html-response"
      : "invalid-json-response";
  return {
    success: false,
    ok: false,
    error: true,
    code:
      args.stage === "preflight"
        ? "PREFLIGHT_TRANSPORT_FAILURE"
        : "DEPLOY_TRANSPORT_FAILURE",
    summary: args.summary,
    framework: args.framework,
    stopReason,
    retryable: false,
    ...(details?.responsePreview ? { responsePreview: details.responsePreview } : {}),
    nextAction:
      "这不是代码级 issues，而是部署通道返回了异常响应。停止自动 deploy / preflight 重试，向用户说明当前平台接口异常，等待服务恢复后再继续。",
  };
}

function formatStoplossPlan(payload: AppStoplossPayload): string {
  return [
    payload.summary,
    payload.responsePreview ? `响应预览: ${payload.responsePreview}` : "",
    "判断: 当前是部署/预检通道异常，不是应用代码问题。",
    "下一步: 停止自动重试，告诉用户当前平台接口返回异常，稍后再试。",
  ]
    .filter(Boolean)
    .join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollAppDeployJob(
  thunkApi: any,
  args: AppDeployArgs,
  toolRunId: string | undefined,
  jobId: string,
  options?: {
    sharedState?: {
      done: boolean;
      result?: AppDeployApiResult;
      failure?: Error;
      error?: string;
      lastSteps: ToolRunStep[];
    };
  }
): Promise<AppDeployApiResult> {
  const sharedState = options?.sharedState;
  let lastSteps: ToolRunStep[] = sharedState?.lastSteps ?? [];
  try {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (sharedState?.done) {
        if (sharedState.result) return sharedState.result;
        if (sharedState.failure) throw sharedState.failure;
        throw new Error(sharedState.error || "部署失败");
      }
      const statusData = await callToolApi<AppDeployStatusResult>(
        thunkApi,
        "/api/app/deploy/status",
        { jobId },
        { withAuth: true }
      );

      const nextSteps = Array.isArray(statusData.steps)
        ? statusData.steps.map((step) => {
            const previous = lastSteps.find((item) => item.id === step.id);
            if (
              previous &&
              TOOL_STEP_STATUS_RANK[step.status] < TOOL_STEP_STATUS_RANK[previous.status]
            ) {
              return previous;
            }
            return step;
          })
        : lastSteps;
      // Only advance lastSteps when server returns a non-empty steps array; this
      // preserves the last known UI state if the server briefly returns empty steps.
      if (nextSteps.length > 0) {
        lastSteps = nextSteps;
        if (sharedState) {
          sharedState.lastSteps = nextSteps;
        }
      }

      updateDeployProgress(
        thunkApi,
        toolRunId,
        lastSteps.length > 0 ? lastSteps : "prepare",
        statusData.summary ?? "正在同步服务端部署状态…",
        statusData.status === "failed" ? "failed" : "running"
      );

      if (statusData.status === "succeeded" && statusData.result) {
        if (sharedState) {
          sharedState.done = true;
          sharedState.result = statusData.result;
        }
        return statusData.result;
      }
      if (statusData.status === "failed") {
        if (
          isTransportStoplossError({
            code: statusData.error?.code,
            details: statusData.error?.details,
            message: statusData.error?.message || statusData.summary,
          })
        ) {
          const payload = buildAppStoplossPayload({
            summary: "部署状态接口返回了异常响应，已停止自动重试。",
            framework: args.framework ?? "worker",
            stage: "deploy",
            error: {
              code: statusData.error?.code,
              details: statusData.error?.details,
              message: statusData.error?.message || statusData.summary,
            },
          });
          const displayMessage = formatStoplossPlan(payload);
          const stoplossError = new ToolResultError(payload.summary, {
            code: payload.code,
            rawData: payload,
            displayData: displayMessage,
            retryable: false,
          });
          if (sharedState) {
            sharedState.done = true;
            sharedState.failure = stoplossError;
            sharedState.error = displayMessage;
          }
          updateDeployProgress(
            thunkApi,
            toolRunId,
            statusData.steps ?? "prepare",
            displayMessage,
            "failed"
          );
          throw stoplossError;
        }
        const rewrittenBase = rewriteAppDeployError(
          statusData.error?.message || statusData.summary || "部署失败",
          args
        );
        const issues =
          statusData.error?.code === "PREFLIGHT_FAILED"
            ? ((statusData.error?.details as { issues?: AppPreflightIssue[] } | undefined)?.issues ?? [])
            : [];
        const repairPayload = buildAppRepairPayload({
          summary: rewrittenBase,
          framework: args.framework ?? "worker",
          issues,
        });
        const rewritten = [
          rewrittenBase,
          formatPreflightIssues(issues),
          formatRepairPlan(repairPayload.repairPlan),
        ]
          .filter(Boolean)
          .join("\n");
        const repairError = new ToolResultError(rewrittenBase, {
          code: statusData.error?.code ?? repairPayload.code,
          rawData: repairPayload,
          displayData: rewritten,
          retryable: true,
        });
        if (sharedState) {
          sharedState.done = true;
          sharedState.failure = repairError;
          sharedState.error = rewritten;
        }
        updateDeployProgress(
          thunkApi,
          toolRunId,
          statusData.steps ?? "prepare",
          rewritten,
          "failed"
        );
        throw repairError;
      }

      await sleep(Math.min(400 + attempt * 50, 2000));
    }

    throw new Error("部署任务仍在服务端执行，请稍后重试查看结果。");
  } finally {
    // Ensure SSE subscriber always sees done=true so it can cancel the reader,
    // even when polling times out or throws an unexpected error.
    if (sharedState && !sharedState.done) {
      sharedState.done = true;
    }
  }
}

async function subscribeToDeployEvents(args: {
  thunkApi: any;
  deployArgs: AppDeployArgs;
  toolRunId?: string;
  jobId: string;
  eventChannel: string;
  sharedState: {
    done: boolean;
    result?: AppDeployApiResult;
    failure?: Error;
    error?: string;
    lastSteps: ToolRunStep[];
  };
}): Promise<void> {
  const { thunkApi, deployArgs, toolRunId, jobId, eventChannel, sharedState } = args;
  const { baseUrl, token } = getToolRequestContext(thunkApi);
  if (!token) return;

  const res = await fetch(`${baseUrl}/api/events/${encodeURIComponent(eventChannel)}`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok || !res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      if (sharedState.done) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
      for (const event of parseSseChunk(chunk)) {
        if (event.type !== "app-deploy-progress" || event.jobId !== jobId) continue;
        const eventSteps = Array.isArray(event.steps)
          ? (event.steps as ToolRunStep[]).map((step) => {
              const previous = sharedState.lastSteps.find((item) => item.id === step.id);
              if (
                previous &&
                TOOL_STEP_STATUS_RANK[step.status] < TOOL_STEP_STATUS_RANK[previous.status]
              ) {
                return previous;
              }
              return step;
            })
          : sharedState.lastSteps;
        sharedState.lastSteps = eventSteps;
        const status = typeof event.status === "string" ? event.status : "running";
        const summary =
          typeof event.summary === "string" ? event.summary : "正在接收服务端部署事件…";

        updateDeployProgress(
          thunkApi,
          toolRunId,
          eventSteps.length > 0 ? eventSteps : "prepare",
          summary,
          status === "failed" ? "failed" : status === "succeeded" ? "succeeded" : "running"
        );

        if (status === "succeeded" && event.result) {
          sharedState.done = true;
          sharedState.result = event.result as AppDeployApiResult;
          return;
        }
        if (status === "failed") {
          if (
            isTransportStoplossError({
              code: (event.error as { code?: string } | undefined)?.code,
              details: (event.error as { details?: unknown } | undefined)?.details,
              message: (event.error as { message?: string } | undefined)?.message || summary,
            })
          ) {
            const payload = buildAppStoplossPayload({
              summary: "部署事件流返回了异常响应，已停止自动重试。",
              framework: deployArgs.framework ?? "worker",
              stage: "deploy",
              error: {
                code: (event.error as { code?: string } | undefined)?.code,
                details: (event.error as { details?: unknown } | undefined)?.details,
                message: (event.error as { message?: string } | undefined)?.message || summary,
              },
            });
            const displayMessage = formatStoplossPlan(payload);
            const stoplossError = new ToolResultError(payload.summary, {
              code: payload.code,
              rawData: payload,
              displayData: displayMessage,
              retryable: false,
            });
            sharedState.done = true;
            sharedState.failure = stoplossError;
            sharedState.error = displayMessage;
            updateDeployProgress(
              thunkApi,
              toolRunId,
              eventSteps.length > 0 ? eventSteps : "prepare",
              displayMessage,
              "failed"
            );
            return;
          }
          const rewrittenBase = rewriteAppDeployError(
            (event.error as { message?: string } | undefined)?.message || summary || "部署失败",
            deployArgs
          );
          const issues =
            (event.error as { code?: string; details?: { issues?: AppPreflightIssue[] } } | undefined)?.code === "PREFLIGHT_FAILED"
              ? (((event.error as { details?: { issues?: AppPreflightIssue[] } } | undefined)?.details)
                  ?.issues ?? [])
              : [];
          const repairPayload = buildAppRepairPayload({
            summary: rewrittenBase,
            framework: deployArgs.framework ?? "worker",
            issues,
          });
          const rewritten = [
            rewrittenBase,
            formatPreflightIssues(issues),
            formatRepairPlan(repairPayload.repairPlan),
          ]
            .filter(Boolean)
            .join("\n");
          const repairError = new ToolResultError(rewrittenBase, {
            code: (event.error as { code?: string } | undefined)?.code ?? repairPayload.code,
            rawData: repairPayload,
            displayData: rewritten,
            retryable: true,
          });
          sharedState.done = true;
          sharedState.failure = repairError;
          sharedState.error = rewritten;
          updateDeployProgress(
            thunkApi,
            toolRunId,
            eventSteps.length > 0 ? eventSteps : "prepare",
            rewritten,
            "failed"
          );
          return;
        }
      }
    }
  } finally {
    // Cancel the SSE reader on every exit path (success, failure, external done,
    // natural stream end) so the underlying HTTP connection is always released.
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ──────────────────────────────────────────────────────────
// appDeploy — 部署或更新一个 Web 应用
// ──────────────────────────────────────────────────────────
export const appDeployFunctionSchema = {
  name: "appDeploy",
  description:
    "将 JavaScript/TypeScript 代码部署为 Web 应用。" +
    "默认部署到平台服务器（nolo.chat/apps/{appId}/），无需用户配置任何额外账号，立即可访问。" +
    "代码必须是 ES Module 格式（export default { fetch(req) {} }）。" +
    "支持多文件项目：通过 files 数组传入，服务端自动打包。" +
    "新建应用时使用 name；更新已有应用时必须优先传 appId，避免因为名称重复而误建新应用。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "应用名称，只允许字母、数字、连字符，例如 'my-app' 或 'bmi-calculator'。仅用于新建应用；更新已有应用时应优先传 appId，服务端会自动沿用历史名称。",
      },
      code: {
        type: "string",
        description:
          "单文件应用代码，必须是 ES Module 格式。与 files 二选一。" +
          "示例：\n" +
          "export default {\n" +
          "  async fetch(request, env, ctx) {\n" +
          "    return new Response('Hello World!');\n" +
          "  }\n" +
          "};",
      },
      files: {
        type: "array",
        description: "多文件项目，与 code 二选一。服务端自动打包。普通 Worker 入口用 index.ts/main.ts/worker.ts；React SPA 推荐 main.tsx + App.tsx。",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "文件名，如 'index.ts' 或 'utils/helper.ts'" },
            code: { type: "string", description: "文件内容" },
          },
          required: ["name", "code"],
        },
      },
      pages: {
        type: "array",
        description: "兼容别名，等同于 files。若上游生成的是 pages 字段，系统会自动按 files 处理。",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "文件名，如 'App.tsx'" },
            code: { type: "string", description: "文件内容" },
          },
          required: ["name", "code"],
        },
      },
      appId: {
        type: "string",
        description:
          "应用 ID（服务器返回的 ULID）。" +
          "创建新应用时不要传此字段，服务器会自动生成并在响应中返回。" +
          "更新已有应用时，填入上次部署响应中返回的 appId，实现覆盖更新而非新建。",
      },
      framework: {
        type: "string",
        enum: ["worker", "react-spa", "nolo-react"],
        description:
          "应用框架。" +
          "'worker'（默认）：直接部署 export default { fetch } 代码。" +
          "'react-spa'：部署多文件 React 单页应用，适合复杂交互、图表和组件化页面。React SPA 模式必须配合 files 使用。" +
          "'nolo-react'：部署统一 Nolo React SSR 应用，适合自定义域名、SEO、OG/meta 和可维护多文件源码。默认依赖只支持 react 与 react-dom，必须配合 files 使用。",
      },
      spaceId: {
        type: "string",
        description:
          "可选的 Space ID。默认会优先使用当前正在编辑/对话的空间。" +
          "如果是尚未绑定空间的旧应用，重新部署时会把它绑定到该空间；" +
          "已经绑定空间的应用不会因为这个字段被迁移。",
      },
    },
    anyOf: [
      { required: ["name"] },
      { required: ["appId"] },
    ],
    // note: 新建应用时必须显式提供 name；更新已有应用时允许仅传 appId
  },
};

export const appPreflightFunctionSchema = {
  name: "appPreflight",
  description:
    "在真正部署前先做应用预检，检查 React SPA / Worker 的入口文件、白名单依赖、图标名、CSS import 和常见部署错误。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "应用名称。新建应用建议传；更新已有应用时可配合 appId 一起传。",
      },
      code: {
        type: "string",
        description: "单文件 Worker 代码，与 files 二选一。",
      },
      files: {
        type: "array",
        description: "多文件源码，与 code 二选一。React SPA 推荐 main.tsx + App.tsx。",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            code: { type: "string" },
          },
          required: ["name", "code"],
        },
      },
      pages: {
        type: "array",
        description: "兼容别名，等同于 files。",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            code: { type: "string" },
          },
          required: ["name", "code"],
        },
      },
      appId: {
        type: "string",
        description: "已存在应用的 appId；用于更新前校验。",
      },
      framework: {
        type: "string",
        enum: ["worker", "react-spa", "nolo-react"],
      },
      spaceId: {
        type: "string",
        description: "可选 Space ID。",
      },
    },
    anyOf: [{ required: ["name"] }, { required: ["appId"] }],
  },
};

export async function appPreflightFunc(
  rawArgs: AppDeployArgs,
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const args = normalizeAppDeployArgs(rawArgs);
  const deploySpaceId = await resolveAppDeploySpaceId(args, thunkApi);
  const data = await callToolApi<AppPreflightResult>(
    thunkApi,
    "/api/app/preflight",
    {
      name: args.name,
      code: args.code,
      files: args.files,
      appId: args.appId,
      framework: args.framework,
      ...(deploySpaceId ? { spaceId: deploySpaceId } : {}),
    },
    { withAuth: true }
  );

  const lines = [
    data.ok ? "✅ 预检通过" : "❌ 预检失败",
    `- 框架: ${data.framework}`,
    `- 摘要: ${data.summary}`,
  ];
  const repairPayload = data.ok
    ? null
    : buildAppRepairPayload({
        summary: data.summary,
        framework: data.framework,
        issues: data.issues,
        warnings: data.warnings,
        entryFile: data.entryFile,
        externalImports: data.externalImports,
      });
  if (data.entryFile) lines.push(`- 入口文件: ${data.entryFile}`);
  if (data.issues?.length) {
    lines.push(`\n问题:\n${formatPreflightIssues(data.issues)}`);
  }
  if (repairPayload?.repairPlan) {
    lines.push(`\n${formatRepairPlan(repairPayload.repairPlan)}`);
  }
  if (data.warnings?.length) {
    lines.push(`\n警告:\n${data.warnings.map((warning) => `- ${warning}`).join("\n")}`);
  }

  return {
    rawData: repairPayload ?? data,
    displayData: lines.join("\n"),
  };
}

export async function appDeployFunc(
  rawArgs: AppDeployArgs,
  thunkApi: any,
  context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData: string }> {
  const args = normalizeAppDeployArgs(rawArgs);
  const { name, code, files, appId, framework } = args;
  const deploySpaceId = await resolveAppDeploySpaceId(args, thunkApi);
  const toolRunId = context?.toolRunId;
  if (!name && !appId) throw new Error("必须提供 name 参数（新建应用时必填；更新已有应用时可省略，服务端从 appId 记录中自动补充）");
  if (framework === "react-spa" && code && (!files || files.length === 0)) {
    throw new Error('React SPA 需要传 `files`（至少 `main.tsx` + `App.tsx`），不能只传 `code`。');
  }
  if (!code && (!files || files.length === 0) && !appId) {
    throw new Error("新建应用必须提供 code 或 files；更新已有应用可仅传 appId，服务端会从源码工作区/历史源码重新部署。");
  }
  if ((rawArgs as { deployTarget?: string }).deployTarget && (rawArgs as { deployTarget?: string }).deployTarget !== "platform") {
    throw new Error("已不再支持 Cloudflare 部署目标，请使用平台托管。");
  }

  updateDeployProgress(
    thunkApi,
    toolRunId,
    "prepare",
    "正在整理部署参数…",
    "running",
    !code && (!files || files.length === 0) && appId
      ? "准备从已有源码工作区重新部署"
      : framework === "react-spa"
        ? "准备 React SPA 多文件构建"
        : "准备单文件 Worker / 多文件 Worker 部署"
  );

  const guardUserInput = context?.userInput ?? getLatestUserInputFromThunk(thunkApi);
  if (appId && (code || (files && files.length > 0)) && guardUserInput) {
    try {
      const previousSource = await callToolApi<{
        code?: string;
        files?: AppSourceFile[];
      }>(thunkApi, "/api/app/prepare-edit", { appId }, { withAuth: true });
      const guardResult = evaluateSmallVisualEditGuard({
        userInput: guardUserInput,
        previousSource,
        nextSource: { code, files },
      });
      if (!guardResult.ok) {
        updateDeployProgress(
          thunkApi,
          toolRunId,
          "prepare",
          guardResult.summary,
          "failed",
          "检测到小视觉修改超出范围，要求先收敛改动"
        );
        throw new ToolResultError(guardResult.summary, {
          code: guardResult.rawData.code,
          rawData: guardResult.rawData,
          displayData: guardResult.displayData,
          retryable: true,
        });
      }
    } catch (error: any) {
      if (
        error instanceof ToolResultError ||
        error?.name === "ToolResultError" ||
        error?.code === "SMALL_VISUAL_SCOPE_EXCEEDED"
      ) {
        throw error;
      }
    }
  }

  let preflightData: AppPreflightResult;
  try {
    preflightData = await callToolApi<AppPreflightResult>(
      thunkApi,
      "/api/app/preflight",
      {
        name,
        code,
        files,
        appId,
        framework,
        ...(deploySpaceId ? { spaceId: deploySpaceId } : {}),
      },
      { withAuth: true }
    );
  } catch (error: any) {
    if (isTransportStoplossError(error)) {
      const payload = buildAppStoplossPayload({
        summary: "预检接口返回了异常响应，暂时无法判断代码问题。",
        framework: framework ?? "worker",
        stage: "preflight",
        error,
      });
      const displayMessage = formatStoplossPlan(payload);
      updateDeployProgress(
        thunkApi,
        toolRunId,
        "preflight",
        displayMessage,
        "failed",
        "检测到预检通道异常，已停止自动重试"
      );
      throw new ToolResultError(payload.summary, {
        code: payload.code,
        rawData: payload,
        displayData: displayMessage,
        retryable: false,
      });
    }
    const rewritten = rewriteAppDeployError(toErrorMessage(error), args);
    const issues = (error?.details as { issues?: AppPreflightIssue[] } | undefined)?.issues ?? [];
    const repairPayload = buildAppRepairPayload({
      summary: rewritten,
      framework: framework ?? "worker",
      issues,
    });
    const displayMessage = [
      rewritten,
      formatPreflightIssues(issues),
      formatRepairPlan(repairPayload.repairPlan),
    ]
      .filter(Boolean)
      .join("\n");
    updateDeployProgress(
      thunkApi,
      toolRunId,
      "preflight",
      displayMessage,
      "failed",
      "预检接口执行失败"
    );
    throw new ToolResultError(rewritten, {
      code: error?.code ?? repairPayload.code,
      rawData: repairPayload,
      displayData: displayMessage,
      retryable: true,
    });
  }

  if (!preflightData.ok) {
    const repairPayload = buildAppRepairPayload({
      summary: preflightData.summary,
      framework: preflightData.framework,
      issues: preflightData.issues,
      warnings: preflightData.warnings,
      entryFile: preflightData.entryFile,
      externalImports: preflightData.externalImports,
    });
    const displayMessage = [
      preflightData.summary,
      formatPreflightIssues(preflightData.issues),
      formatRepairPlan(repairPayload.repairPlan),
    ]
      .filter(Boolean)
      .join("\n");
    updateDeployProgress(
      thunkApi,
      toolRunId,
      "preflight",
      displayMessage,
      "failed",
      "请先修复预检问题，再重新部署"
    );
    throw new ToolResultError(preflightData.summary, {
      code: "PREFLIGHT_FAILED",
      rawData: repairPayload,
      displayData: displayMessage,
      retryable: true,
    });
  }

  updateDeployProgress(
    thunkApi,
    toolRunId,
    "preflight",
    preflightData.summary || "预检通过",
    "succeeded",
    preflightData.entryFile
      ? `入口文件：${preflightData.entryFile}`
      : framework === "react-spa"
        ? "React SPA 约束检查通过"
        : "Worker 约束检查通过"
  );

  let startData: AppDeployStartResult;
  try {
    startData = await callToolApi<AppDeployStartResult>(
      thunkApi,
      "/api/app/deploy",
      {
        name,
        code,
        files,
        appId,
        framework,
        ...(deploySpaceId ? { spaceId: deploySpaceId } : {}),
      },
      { withAuth: true }
    );
  } catch (error: any) {
    if (isTransportStoplossError(error)) {
      const payload = buildAppStoplossPayload({
        summary: "部署接口返回了异常响应，当前不能继续自动部署。",
        framework: framework ?? "worker",
        stage: "deploy",
        error,
      });
      const displayMessage = formatStoplossPlan(payload);
      updateDeployProgress(
        thunkApi,
        toolRunId,
        framework === "react-spa" ? "build" : "prepare",
        displayMessage,
        "failed",
        "检测到部署通道异常，已停止自动重试"
      );
      throw new ToolResultError(payload.summary, {
        code: payload.code,
        rawData: payload,
        displayData: displayMessage,
        retryable: false,
      });
    }
    const rewritten = rewriteAppDeployError(toErrorMessage(error), args);
    const issues = (error?.details as { issues?: AppPreflightIssue[] } | undefined)?.issues ?? [];
    const repairPayload = buildAppRepairPayload({
      summary: rewritten,
      framework: framework ?? "worker",
      issues,
    });
    const displayMessage = [
      rewritten,
      formatPreflightIssues(issues),
      formatRepairPlan(repairPayload.repairPlan),
    ]
      .filter(Boolean)
      .join("\n");
    updateDeployProgress(
      thunkApi,
      toolRunId,
      framework === "react-spa" ? "build" : "prepare",
      displayMessage,
      "failed",
      "请根据提示调整参数或代码后重试"
    );
    throw new ToolResultError(rewritten, {
      code: error?.code ?? repairPayload.code,
      rawData: repairPayload,
      displayData: displayMessage,
      retryable: true,
    });
  }

  updateDeployProgress(
    thunkApi,
    toolRunId,
    startData.steps ?? "prepare",
    startData.summary ?? "部署请求已发送到服务端…",
    "running"
  );
  const sharedState = {
    done: false,
    result: undefined as AppDeployApiResult | undefined,
    failure: undefined as Error | undefined,
    error: undefined as string | undefined,
    lastSteps: Array.isArray(startData.steps) ? startData.steps : [],
  };
  const ssePromise = startData.eventChannel
    ? subscribeToDeployEvents({
        thunkApi,
        deployArgs: args,
        toolRunId,
        jobId: startData.jobId,
        eventChannel: startData.eventChannel,
        sharedState,
      }).catch(() => {
        // SSE 仅作为加速通道，失败后由轮询兜底
      })
    : Promise.resolve();

  const data = await pollAppDeployJob(thunkApi, args, toolRunId, startData.jobId, {
    sharedState,
  });
  void ssePromise;
  const primaryUrl = data.customUrl ?? data.url;
  const previewCheck = data.previewCheck;
  const previewReady = data.previewReady ?? previewCheck?.ready;

  // 部署成功后将 appRecord 同步到本地 DB 和所有 syncServers
  if (data.appKey && data.appRecord) {
    void thunkApi.dispatch(syncAppRecord(data.appKey, data.appRecord));
  }

  // 通知对话编辑器刷新左侧预览 iframe（UI4）。
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("app-editor-refresh"));
  }

  const lines = [
    `🚀 应用部署成功！`,
    `- 名称: ${data.userFriendlyName}`,
    ...(data.appId ? [`- appId: ${data.appId}`] : []),
    `- 访问地址: ${primaryUrl}`,
    `- 更新时间: ${data.modifiedOn ?? "刚刚"}`,
  ];

  if (data.bundleWarnings?.length) {
    lines.push(`\n⚠️ 打包警告:\n${data.bundleWarnings.join("\n")}`);
  }
  if (previewCheck?.attempted && previewReady === false) {
    lines.push("\n⏳ 站点已发布，但首次加载可能稍慢；聊天卡片里会继续显示预览加载状态。");
  }
  lines.push(`\n可以直接访问 ${primaryUrl} 测试效果。`);

  return {
    rawData: { ...data, appUrl: primaryUrl, previewCheck },
    displayData: lines.join("\n"),
  };
}

// ──────────────────────────────────────────────────────────
// appList — 列出用户已部署的所有应用
// ──────────────────────────────────────────────────────────
export const appListFunctionSchema = {
  name: "appList",
  description: "列出应用列表。不传 spaceId 时列出当前用户自己的应用；传入 spaceId 时列出该 Space 下的应用。",
  parameters: {
    type: "object",
    properties: {
      spaceId: {
        type: "string",
        description: "可选。若提供，则只列出该 Space 下的应用。",
      },
    },
  },
};

export async function appListFunc(
  args: { spaceId?: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const data = await callToolApi<{
    success: boolean;
    workers: Array<{
      userFriendlyName: string;
      url: string;
      customUrl?: string;
      appId?: string;
      modifiedOn: string;
    }>;
  }>(thunkApi, "/api/app/list", args?.spaceId ? { spaceId: args.spaceId } : {}, { withAuth: true });

  if (!data.workers.length) {
    return {
      rawData: data,
      displayData: "📭 你还没有部署任何应用。",
    };
  }

  const list = data.workers
    .map((w) => {
      const url = w.customUrl ?? w.url;
      const id = w.appId ? ` (appId: ${w.appId})` : "";
      return `- **${w.userFriendlyName}**${id}: ${url}  (更新: ${w.modifiedOn?.slice(0, 10) ?? "-"})`;
    })
    .join("\n");

  return {
    rawData: data,
    displayData: `📋 已部署的应用 (${data.workers.length} 个):\n${list}`,
  };
}

// ──────────────────────────────────────────────────────────
// appDelete — 删除一个应用
// ──────────────────────────────────────────────────────────
export const appDeleteFunctionSchema = {
  name: "appDelete",
  description: "删除一个已部署的应用。删除后 URL 立即失效，不可恢复。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID。必须先用 appList / appDeploy / appRead 拿到它，再按 appId 删除。",
      },
    },
    required: ["appId"],
  },
};

export async function appDeleteFunc(
  args: { appId: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { appId } = args;
  if (!appId) throw new Error("必须提供 appId 参数；请先调用 appList 或 appRead 获取目标应用 ID");

  // 先获取 appKey，再走全 server 删除路径
  const appInfo = await callToolApi<{
    appKey?: string;
    appId?: string;
    name?: string;
  }>(thunkApi, "/api/app/get", { appId }, { withAuth: true });

  if (!appInfo.appKey) {
    throw new Error("无法解析 appKey，无法执行统一删除");
  }

  await thunkApi.dispatch(deleteDbKey(appInfo.appKey));

  return {
    rawData: { deleted: true },
    displayData: `🗑️ 应用 "${appInfo.name ?? appId}" 已成功删除。`,
  };
}

// ──────────────────────────────────────────────────────────
// appRead — 读取应用当前代码（用于修改前获取现有内容）
// ──────────────────────────────────────────────────────────
export const appReadFunctionSchema = {
  name: "appRead",
  description:
    "读取已部署应用的当前代码。在修改应用（增删功能、调整样式等）之前，必须先调用此工具获取现有代码，再基于现有代码进行修改后重新部署。必须传 appId；如还不知道 appId，请先调用 appList。对于大型应用，服务端 agent runtime 可能返回源码摘要、文件清单和预览，而不是完整源码；这不是读取失败，应先基于摘要定位范围，避免把整站源码原样塞进下一次工具调用。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID（从 appList 或之前的 appRead/appDeploy 返回结果中获取）。比 name 更精确，后续更新/删除都应优先使用。",
      },
    },
    required: ["appId"],
  },
};

export async function appReadFunc(
  args: { appId: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { appId } = args;
  if (!appId) throw new Error("必须提供 appId 参数；请先调用 appList 获取目标应用 ID");

  const data = await callToolApi<{
    success: boolean;
    appId: string;
    userFriendlyName: string;
    url: string;
    customUrl?: string;
    code?: string;
    files?: Array<{ name: string; code: string }>;
    sourceFiles?: Array<{
      path: string;
      sizeBytes: number;
      lineCount: number;
      preview: string;
      truncated: boolean;
    }>;
    workspaceRef?: Record<string, any>;
    activeCommit?: string;
    framework?: "worker" | "react-spa" | "nolo-react";
  }>(thunkApi, "/api/app/prepare-edit", { appId }, { withAuth: true });

  const primaryUrl = data.customUrl ?? data.url;
  const displayBody =
    Array.isArray(data.files) && data.files.length > 0
      ? data.files
        .map((file) => `### ${file.name}\n\`\`\`${file.name.endsWith(".tsx") || file.name.endsWith(".ts") ? "typescript" : "javascript"}\n${file.code}\n\`\`\``)
        .join("\n\n")
      : Array.isArray(data.sourceFiles) && data.sourceFiles.length > 0
        ? data.sourceFiles
            .map((file) => {
              const lang = file.path.endsWith(".tsx") || file.path.endsWith(".ts")
                ? "typescript"
                : file.path.endsWith(".json")
                  ? "json"
                  : "text";
              return [
                `### ${file.path}`,
                `- ${file.sizeBytes} bytes, ${file.lineCount} lines${file.truncated ? " (preview)" : ""}`,
                `\`\`\`${lang}`,
                file.preview,
                "```",
              ].join("\n");
            })
            .join("\n\n")
        : "```javascript\n" + (data.code ?? "") + "\n```";
  const snapshotWarning = buildAppReadSnapshotWarning(
    classifyAppReadSnapshot(data)
  );
  const styleSystemAnalysis = analyzeAppStyleSystem(data);
  const styleSystemHint = buildAppStyleSystemHint(styleSystemAnalysis);

  return {
    rawData: {
      ...data,
      styleSystemStatus: styleSystemAnalysis.status,
      legacyMigrationRecommended:
        styleSystemAnalysis.legacyMigrationRecommended,
      styleSystemEvidence: styleSystemAnalysis.evidence,
      ...(styleSystemHint ? { styleSystemHint } : {}),
    },
    displayData:
      `📄 应用 "${data.userFriendlyName}" 当前代码：\n` +
      `- appId: ${data.appId}\n` +
      `- 访问地址: ${primaryUrl}\n` +
      (data.workspaceRef ? `- workspace: ${data.workspaceRef.kind ?? "workspace"}\n` : "") +
      (data.activeCommit ? `- activeCommit: ${data.activeCommit}\n` : "") +
      (snapshotWarning ? `\n${snapshotWarning}\n` : "\n") +
      (styleSystemHint ? `\n${styleSystemHint}\n` : "") +
      "\n" +
      displayBody,
  };
}

// ──────────────────────────────────────────────────────────
// appFileList / appFileRead / appFileReplace / appFileWrite — app-scoped aliases over the
// shared coding-agent workspace file semantics.
// ──────────────────────────────────────────────────────────
export const appFileListFunctionSchema = {
  name: "appFileList",
  description:
    "列出 Nolo React SSR 应用源码工作区的文件清单。它是 App Builder 受限版 listFiles：只绑定当前 app 源码 workspace，不会返回完整源码。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID。必须先用 appList/appRead 获取。",
      },
    },
    required: ["appId"],
  },
};

export const appFileReadFunctionSchema = {
  name: "appFileRead",
  description:
    "读取 Nolo React SSR 应用源码工作区里的单个文件或指定行范围。它是 App Builder 受限版 readFile；大文件应优先传 startLine/endLine。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID。必须先用 appList/appRead 获取。",
      },
      path: {
        type: "string",
        description: "源码工作区内的相对路径，例如 src/App.tsx 或 nolo.app.json。不能使用绝对路径或 ../。",
      },
      startLine: {
        type: "number",
        description: "可选，1-based 起始行。读取大文件时优先使用。",
      },
      endLine: {
        type: "number",
        description: "可选，1-based 结束行。读取大文件时优先使用。",
      },
    },
    required: ["appId", "path"],
  },
};

export const appFileSearchFunctionSchema = {
  name: "appFileSearch",
  description:
    "在 Nolo React SSR 应用源码工作区搜索关键词或正则。它是 App Builder 受限版 searchFiles；先定位命中行，再用 appFileRead 读取范围或 appFileReplace 精确编辑。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID。必须先用 appList/appRead 获取。",
      },
      query: {
        type: "string",
        description: "要搜索的关键词或正则表达式。",
      },
      path: {
        type: "string",
        description: "可选，限制在某个源码相对路径中搜索，例如 src/App.tsx。",
      },
      contextLines: {
        type: "number",
        description: "可选，每条命中前后返回几行上下文，最大 5，默认 2。",
      },
      maxMatches: {
        type: "number",
        description: "可选，最多返回多少条命中，最大 50，默认 20。",
      },
      regex: {
        type: "boolean",
        description: "可选，为 true 时按正则匹配；默认按普通字符串包含匹配。",
      },
    },
    required: ["appId", "query"],
  },
};

export const appFileWriteFunctionSchema = {
  name: "appFileWrite",
  description:
    "写入 Nolo React SSR 应用源码工作区里的单个文件。它是 App Builder 受限版 writeFile，会提交 app workspace git；仅用于新建文件或确实需要整文件重写。文字、样式、token、局部逻辑等小改动应先用 appFileReplace；写完后必须 appPreflight 再 appDeploy。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID。必须先用 appList/appRead 获取。",
      },
      path: {
        type: "string",
        description: "源码工作区内的相对路径，例如 src/App.tsx。不能使用绝对路径或 ../。",
      },
      code: {
        type: "string",
        description: "完整的新文件内容。这个工具按单文件替换写入，不接受 diff。",
      },
      message: {
        type: "string",
        description: "可选的 git commit message；不传时服务端会用 Update {path}。",
      },
    },
    required: ["appId", "path", "code"],
  },
};

export const appFileReplaceFunctionSchema = {
  name: "appFileReplace",
  description:
    "在 Nolo React SSR 应用源码工作区里用唯一 oldText 精确替换为 newText。它是 App Builder 受限版 editFile，会提交 app workspace git；文字、样式、token、局部逻辑等小改动优先使用此工具。",
  parameters: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "应用 ID。必须先用 appList/appRead 获取。",
      },
      path: {
        type: "string",
        description: "源码工作区内的相对路径，例如 src/App.tsx。不能使用绝对路径或 ../。",
      },
      oldText: {
        type: "string",
        description: "目标文件中必须唯一出现的旧代码片段。若出现 0 次或多次，工具会拒绝。",
      },
      newText: {
        type: "string",
        description: "替换后的新代码片段。",
      },
      message: {
        type: "string",
        description: "可选的 git commit message；不传时服务端会用 Update {path}。",
      },
    },
    required: ["appId", "path", "oldText", "newText"],
  },
};

export async function appFileListFunc(
  args: { appId: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const data = await callToolApi<any>(thunkApi, "/api/app/file/list", args, { withAuth: true });
  const files = Array.isArray(data.sourceFiles) ? data.sourceFiles : [];
  return {
    rawData: data,
    displayData:
      `📁 应用源码文件：${data.appId}\n` +
      `- activeCommit: ${data.activeCommit ?? "unknown"}\n` +
      files.map((file: any) => `- ${file.path} (${file.sizeBytes} bytes)`).join("\n"),
  };
}

export async function appFileReadFunc(
  args: { appId: string; path: string; startLine?: number; endLine?: number },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const data = await callToolApi<any>(thunkApi, "/api/app/file/read", args, { withAuth: true });
  const lang =
    String(data.path ?? args.path).endsWith(".tsx") || String(data.path ?? args.path).endsWith(".ts")
      ? "typescript"
      : String(data.path ?? args.path).endsWith(".json")
        ? "json"
        : "text";
  return {
    rawData: data,
    displayData:
      `📄 ${data.path}\n` +
      `- appId: ${data.appId}\n` +
      `- activeCommit: ${data.activeCommit ?? "unknown"}\n\n` +
      (data.startLine || data.endLine
        ? `- lines: ${data.startLine ?? 1}-${data.endLine ?? data.lineCount} of ${data.lineCount}\n\n`
        : "") +
      `\`\`\`${lang}\n${data.code ?? ""}\n\`\`\``,
  };
}

export async function appFileSearchFunc(
  args: { appId: string; query: string; path?: string; contextLines?: number; maxMatches?: number; regex?: boolean },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const data = await callToolApi<any>(thunkApi, "/api/app/file/search", args, { withAuth: true });
  const matches = Array.isArray(data.matches) ? data.matches : [];
  return {
    rawData: data,
    displayData:
      `🔎 应用源码搜索：${args.query}\n` +
      `- appId: ${data.appId}\n` +
      `- activeCommit: ${data.activeCommit ?? "unknown"}\n` +
      `- matches: ${matches.length}\n\n` +
      matches
        .map((match: any) => `${match.path}:${match.line}: ${match.text}`)
        .join("\n"),
  };
}

export async function appFileWriteFunc(
  args: { appId: string; path: string; code: string; message?: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const data = await callToolApi<any>(thunkApi, "/api/app/file/write", args, { withAuth: true });
  return {
    rawData: data,
    displayData:
      `✏️ 已写入应用源码文件：${args.path}\n` +
      `- appId: ${data.appId}\n` +
      `- activeCommit: ${data.activeCommit ?? "unknown"}\n` +
      "下一步：先 appPreflight，再 appDeploy。",
  };
}

export async function appFileReplaceFunc(
  args: { appId: string; path: string; oldText: string; newText: string; message?: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const data = await callToolApi<any>(thunkApi, "/api/app/file/replace", args, { withAuth: true });
  return {
    rawData: data,
    displayData:
      `✏️ 已替换应用源码文件片段：${args.path}\n` +
      `- appId: ${data.appId}\n` +
      `- activeCommit: ${data.activeCommit ?? "unknown"}\n` +
      "下一步：先 appPreflight，再 appDeploy。",
  };
}
