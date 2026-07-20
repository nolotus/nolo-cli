// 文件路径: packages/chat/dialog/actions/createDialogAction.ts

import { selectIdentityUserId } from "identity/selectors";
import { isRecord } from "../../../core/isRecord";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { extractCustomId } from "../../../core/prefix";
import { addContentToSpace } from "../../../create/space/spaceSlice";
import { DataType } from "../../../create/types";
import {
  read,
  readAndWait,
  removeCachedEntity,
  upsertSSREntity,
  write,
} from "../../../database/dbSlice";
import { createDialogKey } from "../../../database/keys";
import { format, formatISO } from "date-fns";
import { prepareAndPersistMessage } from "../../messages/messageSlice";
import { buildBuiltinObjectAssistantAgentFromKey } from "../objectAssistantRegistry";

import type { Agent, DialogConfig } from "../../../app/types";
import type { UiOption } from "../../messages/types";
import {
  uiAskChoiceFunc,
  uiAskChoiceFunctionSchema,
} from "../../../ai/tools/uiAskChoiceTool";
import {
  resolveRecentRelationshipRecap,
  mergeGreetingWithRelationshipRecap,
  shouldUseRecentRelationshipRecap,
} from "../../../ai/memory/recentRelationshipRecap";
import {
  mergeGreetingWithUnderstandingMemory,
  resolveUnderstandingGreetingMemory,
} from "../../../ai/memory/understandingGreeting";

// 仅在本文件内使用的轻量 greeting 定义，避免强依赖全局 Agent 类型已更新
interface AgentGreetingMenuItem extends UiOption {
  group?: string;
}

interface AgentGreetingConfig {
  text?: string;
  menu?: AgentGreetingMenuItem[];
}

interface CreateDialogArgs {
  cybots: string[];
  category?: string;
  title?: string;
  /**
   * Optional explicit target space.
   *
   * Important:
   * - View-mode based scoping must be decided by the UI entry that triggers creation
   *   (currently the sidebar-top create button).
   * - This action must preserve explicit caller intent. If a caller passes `spaceId`,
   *   we use it as-is. If omitted, we create an unscoped dialog.
   */
  spaceId?: string;
  inheritFromDialogKey?: string;
  skipGreeting?: boolean;
  triggerType?: "user" | "api" | "localhost" | "scheduled_run" | "automation_run";
  schedule?: string;
  taskPrompt?: string;
  skipAgentConfigRead?: boolean;
  optimisticReturnBeforeWrite?: boolean;
  preferredServerOrigin?: string | null;
  extraReferences?: import("../../../app/types").ReferenceItem[];
}

// `cybot-local-` 是更名前的设备本地 key 前缀，存量本地对话仍可能引用，仅保留识别
const LOCAL_OWNER_DIALOG_PREFIXES = ["agent-local-", "cybot-local-"];

/**
 * Returns true when the dialog references a device-local agent
 * (e.g. `agent-local-*`). Such dialogs must always be
 * owned by `"local"`, even when an account is currently logged in.
 */
export const isLocalOwnerDialogAgents = (cybots: readonly string[]): boolean => {
  if (!Array.isArray(cybots)) return false;
  for (const agentKey of cybots) {
    if (typeof agentKey !== "string") continue;
    for (const prefix of LOCAL_OWNER_DIALOG_PREFIXES) {
      if (agentKey.startsWith(prefix)) return true;
    }
  }
  return false;
};

const notifyUserDataUpdated = () => {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof window.Event === "function"
  ) {
    window.dispatchEvent(new window.Event("nolo-user-data-updated"));
  }
};

export const createDialogAction = async (
  args: CreateDialogArgs,
  thunkApi: any
) => {
  const {
    cybots,
    category,
    spaceId: explicitSpaceId,
    inheritFromDialogKey,
    title: titleOverride,
    triggerType,
    schedule,
    taskPrompt,
    skipAgentConfigRead,
    optimisticReturnBeforeWrite,
    preferredServerOrigin,
  } = args;
  const { dispatch: dispatchRaw, getState, extra } = thunkApi as any;
  const dispatch = dispatchRaw as any;
  const agentKey = cybots[0];
  const currentUserId =
    (selectIdentityUserId(getState()) as string | null | undefined) ?? null;
  const isDeviceLocalDialog = isLocalOwnerDialogAgents(cybots);
  // Per M1-C owner rules:
  //   1. dialogs referencing agent-local- are always "local",
  //      even when an account is logged in.
  //   2. Otherwise owner is the current account; fall back to "local"
  //      when no account is active (logged out).
  const userId: string = isDeviceLocalDialog
    ? "local"
    : currentUserId && currentUserId.trim().length > 0
      ? currentUserId
      : "local";

  try {
    const { localFirstLog } = await import("../../../app/localFirst/localFirstLog");
    localFirstLog("dialog.create", {
      owner: userId,
      agentKey: typeof agentKey === "string" ? agentKey : "",
      isDeviceLocal: isDeviceLocalDialog,
      hasSpace: Boolean(args.spaceId),
    });
  } catch {
    /* diagnostics best-effort */
  }

  const readAgentConfig = async () => {
    const existing = (await dispatch(
      readAndWait({
        dbKey: agentKey,
        preferredServerOrigin,
      })
    ).unwrap().catch(() => null)) as
      | (Agent & { greeting?: string | AgentGreetingConfig })
      | null;
    if (existing) return existing;

    const recoveredBuiltinAgent = buildBuiltinObjectAssistantAgentFromKey(
      agentKey,
      userId
    ) as (Agent & { greeting?: string | AgentGreetingConfig }) | null;

    if (!recoveredBuiltinAgent) {
      return null;
    }

    await dispatch(
      write({
        data: recoveredBuiltinAgent,
        customKey: recoveredBuiltinAgent.dbKey,
        userId,
      })
    ).unwrap();

    return recoveredBuiltinAgent;
  };

  const canSkipAgentConfigRead =
    !!skipAgentConfigRead && !!args.skipGreeting && !!titleOverride;

  // 1. 获取 bot 配置。QuickChat 已经跳过 greeting 且传入标题时，URL 前不需要读取 agent。
  const agentConfig = canSkipAgentConfigRead ? null : await readAgentConfig();

  if (!agentConfig && !canSkipAgentConfigRead) {
    throw new Error(`Agent with key ${agentKey} not found.`);
  }

  const shouldUseRelationshipGreeting = shouldUseRecentRelationshipRecap({
    userId,
    agentKey,
    agentsCount: cybots.length,
    inheritFromDialogKey,
    skipGreeting: args.skipGreeting,
    triggerType,
  });
  const understandingGreetingResolution = shouldUseRelationshipGreeting
    ? await resolveUnderstandingGreetingMemory({
        db: extra?.db,
        userId,
        spaceId: explicitSpaceId,
        agentKey,
      }).catch(() => ({ item: null, anchorItems: [], followUpItem: null }))
    : { item: null, anchorItems: [], followUpItem: null };
  const recentRelationshipRecapResolution =
    shouldUseRelationshipGreeting && !understandingGreetingResolution.item
      ? await resolveRecentRelationshipRecap({
          db: extra?.db,
          userId,
          agentKey,
          currentSpaceId: explicitSpaceId,
        }).catch(() => ({ recap: null, reason: "no-db" as const, sourceDialogKey: undefined }))
      : null;

  if (
    typeof window !== "undefined" &&
    recentRelationshipRecapResolution &&
    process.env.NODE_ENV !== "production"
  ) {
    console.debug("[dialog] recent relationship recap", {
      agentKey,
      userId,
      reason: recentRelationshipRecapResolution.reason,
      sourceDialogKey: recentRelationshipRecapResolution.sourceDialogKey ?? null,
      preview: recentRelationshipRecapResolution.recap ?? null,
    });
  }

  const time = format(new Date(), "MM-dd HH:mm");
  const title = titleOverride || (agentConfig?.name || "Agent") + "  " + time;
  // Important:
  // Space scoping is intentionally entry-driven, not action-driven.
  // Dialog creation must only honor an explicit caller-provided `spaceId`.
  // Omitting `spaceId` means creating an unscoped dialog.
  const spaceId = explicitSpaceId;
  // M1-C: use the resolved owner (local for local agents, otherwise current
  // account) so dialog-local-* matches its Agent record owner. Prevents the
  // dialog from silently inheriting a logged-in account's `userId`.
  const dialogPath = createDialogKey(userId);
  const dialogId = extractCustomId(dialogPath);

  // 1.1 处理继承逻辑
  let referenceKeys: string[] | undefined;
  let inheritedFromDialogKey: string | undefined;
  let inheritedFromDialogTitle: string | undefined;



  if (inheritFromDialogKey) {
    inheritedFromDialogKey = inheritFromDialogKey;
    const sourceDialog = await dispatch(
      read({
        dbKey: inheritFromDialogKey
      })
    ).unwrap();

    if (isRecord(sourceDialog)) {
      const sourceDbKey = (sourceDialog as { dbKey?: unknown }).dbKey;
      if (typeof sourceDbKey === "string" && sourceDbKey.trim().length > 0) {
        inheritedFromDialogKey = sourceDbKey;
      }

      const sourceTitle = asOptionalTrimmedString(
        (sourceDialog as { title?: unknown }).title,
      );
      if (sourceTitle) {
        inheritedFromDialogTitle = sourceTitle;
      }

      const candidate = (sourceDialog as { referenceKeys?: unknown })
        .referenceKeys;

      if (
        Array.isArray(candidate) &&
        candidate.every((key) => typeof key === "string")
      ) {
        referenceKeys = candidate;
      }
    }
  }

  // 2. 准备并写入对话数据
  const dialogData = {
    id: dialogId,
    dbKey: dialogPath,
    userId,
    cybots,
    title,
    type: DataType.DIALOG,
    createdAt: formatISO(new Date()),
    ...(spaceId && { spaceId }),
    category,
    referenceKeys,
    ...(args.extraReferences && args.extraReferences.length > 0 && { extraReferences: args.extraReferences }),
    ...(inheritedFromDialogKey && { inheritedFromDialogKey }),
    ...(inheritedFromDialogTitle && { inheritedFromDialogTitle }),
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    ...(triggerType && { triggerType }),
    ...(triggerType === "scheduled_run" || triggerType === "automation_run"
      ? {
          executionMode: "background" as const,
          status: "pending" as const,
        }
      : {}),
    ...(schedule && { schedule }),
    ...(taskPrompt && { taskPrompt }),
  };

  const canReturnBeforeWrite =
    canSkipAgentConfigRead && !!optimisticReturnBeforeWrite && !spaceId;

  if (canReturnBeforeWrite) {
    const optimisticDialogData = {
      ...dialogData,
      dbKey: dialogPath,
      userId,
    };
    dispatch((upsertSSREntity as any)(optimisticDialogData));
    notifyUserDataUpdated();
    // M1-C: pass `userId` explicitly so writeAction does not fall back to
    // the runtime currentUserId (which may be a logged-in account) and
    // accidentally override the resolved local owner.
    //
    // Latency: still return before write settles. Durability: if the
    // background write fails, remove the exact optimistic entity so the
    // UI does not keep a phantom as if it were durable.
    void dispatch(
      write({
        data: { ...dialogData, userId },
        customKey: dialogPath,
        userId,
      })
    )
      .unwrap()
      .catch((error: unknown) => {
        console.error("[createDialogAction] optimistic dialog write failed", {
          dialogPath,
          error,
        });
        dispatch(removeCachedEntity(dialogPath));
        notifyUserDataUpdated();
      });
    return optimisticDialogData;
  }

  const result = await dispatch(
    write({
      data: { ...dialogData, userId },
      customKey: dialogPath,
      userId,
    })
  ).unwrap();

  // 3. 将对话添加到空间
  if (spaceId) {
    await dispatch(
      (addContentToSpace as any)({
        spaceId,
        contentKey: dialogPath,
        type: DataType.DIALOG,
        title,
        categoryId: category,
        ...(triggerType && { triggerType }),
      })
    );
  }

  // 通知 useUserData 刷新，使新对话立即出现在"最近"列表
  notifyUserDataUpdated();

  // 4. 条件性地创建初始消息：
  //    - greeting 带 menu => 仅发一条 ui_ask_choice 工具消息（不再额外发普通消息）
  //    - 只有 text => 沿用老逻辑，发一条普通 assistant 消息
  const rawGreeting = agentConfig?.greeting;

  if (rawGreeting && !args.skipGreeting) {
    const cfg: AgentGreetingConfig =
      typeof rawGreeting === "string"
        ? { text: rawGreeting }
        : isRecord(rawGreeting)
          ? (rawGreeting as AgentGreetingConfig)
          : { text: String(rawGreeting) };

    const mergedGreetingText = understandingGreetingResolution?.item
      ? mergeGreetingWithUnderstandingMemory({
          greetingText: cfg.text,
          resolution: understandingGreetingResolution,
        })
      : mergeGreetingWithRelationshipRecap({
          greetingText: cfg.text,
          recentRecap: recentRelationshipRecapResolution?.recap,
        });
    const effectiveCfg: AgentGreetingConfig = {
      ...cfg,
      ...(mergedGreetingText ? { text: mergedGreetingText } : {}),
    };

    const hasMenu = Array.isArray(effectiveCfg.menu) && effectiveCfg.menu.length > 0;

    if (hasMenu) {
      // 带菜单：用 ui_ask_choice tool 来承载 greeting + 选项，只发这一条消息
      const question =
        asOptionalTrimmedString(effectiveCfg.text) ??
        "接下来你更希望我帮你做哪件事？";

      const choices = effectiveCfg.menu!.map((item, idx) => ({
        id: item.id || `choice_${idx + 1}`,
        label: item.label,
        userMessage: item.userMessage ?? item.label,
      }));

      const toolResult = await uiAskChoiceFunc(
        {
          question,
          choices,
          blocking: true,
        },
        thunkApi
      );

      await dispatch(
        (prepareAndPersistMessage as any)({
          message: {
            role: "tool",
            toolName: uiAskChoiceFunctionSchema.name,
            cybotKey: agentKey,
            content: toolResult.rawData as any,
            displayData: toolResult.displayData,
          },
          dialogConfig: {
            id: dialogId,
            dbKey: dialogPath,
            userId,
          } as unknown as DialogConfig,
        })
      );
    } else if (effectiveCfg.text) {
      // 只有文本，没有菜单：走老逻辑，发一条普通 greeting
      await dispatch(
        (prepareAndPersistMessage as any)({
          message: {
            content: effectiveCfg.text,
            role: "assistant",
            cybotKey: agentKey,
          },
          dialogConfig: {
            id: dialogId,
            dbKey: dialogPath,
            userId,
          } as unknown as DialogConfig,
        })
      );
    }
  }

  // 5. 返回对话创建结果
  return result;
};
