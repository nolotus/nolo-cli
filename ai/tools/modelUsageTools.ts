export const queryModelUsageFunctionSchema = {
  name: "queryModelUsage",
  description:
    "查询模型/API 用量与费用。普通用户只能查自己的用量；系统管理员可以查指定用户或全站。费用默认返回 credits，也可附带 USD 换算。",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "all", "space"],
        description:
          "查询范围。user 为个人，all 为全站管理员查询，space 预留给空间范围。",
        default: "user",
      },
      userId: {
        type: "string",
        description: "管理员查询指定用户时使用；普通用户不允许指定他人。",
      },
      spaceId: {
        type: "string",
        description: "空间范围查询预留字段，当前版本会返回未实现。",
      },
      provider: {
        type: "string",
        description: "可选 provider 过滤，例如 google、openai、anthropic。",
      },
      model: {
        type: "string",
        description: "可选模型过滤，例如 gemini-3.5-flash。",
      },
      serviceTier: {
        type: "string",
        description: "可选计费档位过滤，例如 standard、flex。",
      },
      startDate: {
        type: "string",
        description: "开始日期，YYYY-MM-DD。默认今天。",
      },
      endDate: {
        type: "string",
        description: "结束日期，YYYY-MM-DD。默认等于 startDate。",
      },
      currency: {
        type: "string",
        description: "展示货币/单位标签。默认 CREDITS；可填 USD、CNY 等。",
        default: "CREDITS",
      },
      creditsPerUsd: {
        type: "number",
        description: "credits 与 USD 的换算比例，默认 8 credits = 1 USD。",
        default: 8,
      },
      thresholdCredits: {
        type: "number",
        description:
          "可选阈值，单位 credits；返回 threshold.exceeded 与 0-100 的 threshold.usedPercent。",
      },
      thresholdUsd: {
        type: "number",
        description:
          "可选阈值，单位 USD；会按 creditsPerUsd 换算，并返回 0-100 的 threshold.usedPercent。",
      },
    },
  },
};

export const createScheduledTaskFunctionSchema = {
  name: "createScheduledTask",
  description:
    "创建一个每日/周期性后台任务。适合让 agent 按 cron 定时检查用量、生成报告或执行提醒；可选择创建后立刻试运行一次。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "任务标题。",
      },
      taskPrompt: {
        type: "string",
        description:
          "定时任务每次执行时交给 agent 的完整任务描述，应包含检查条件和通知方式。",
      },
      schedule: {
        type: "string",
        description: "cron 表达式，例如每天 09:00 执行为 0 9 * * *。",
      },
      agentKey: {
        type: "string",
        description: "执行该任务的 agentKey。默认使用当前 agent。",
      },
      spaceId: {
        type: "string",
        description: "可选空间 ID；任务对话会归属到该空间。",
      },
      runOnceNow: {
        type: "boolean",
        description: "创建后是否立即执行一次，用来验证任务会产生什么结果。",
        default: false,
      },
    },
    required: ["schedule", "taskPrompt"],
  },
};

export const createDialogGoalFunctionSchema = {
  name: "createDialogGoal",
  description:
    "为当前对话创建或替换一个轻量目标，可选设置 token 预算。目标会持久化到当前 dialog。",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "目标描述，应该是可完成的具体任务。",
      },
      tokenBudget: {
        type: "number",
        description: "可选 token 预算。用于报告 used / remaining，不会自动中断运行。",
      },
      dialogId: {
        type: "string",
        description: "可选 dialogId。默认使用当前运行中的对话。",
      },
    },
    required: ["objective"],
  },
};

export const getDialogGoalFunctionSchema = {
  name: "getDialogGoal",
  description:
    "读取当前或指定对话的 goal 状态，并返回 token 使用与剩余预算报告。",
  parameters: {
    type: "object",
    properties: {
      dialogId: {
        type: "string",
        description: "可选 dialogId。默认使用当前运行中的对话。",
      },
    },
  },
};

export const completeDialogGoalFunctionSchema = {
  name: "completeDialogGoal",
  description:
    "将当前或指定对话的 goal 标记为 complete，并持久化完成时间。",
  parameters: {
    type: "object",
    properties: {
      dialogId: {
        type: "string",
        description: "可选 dialogId。默认使用当前运行中的对话。",
      },
    },
  },
};

export const notifyUserFunctionSchema = {
  name: "notifyUser",
  description:
    "发送一条站内通知给当前用户。第一版只支持站内通知，后续可扩展邮件、桌面端、网页和移动端通知。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "通知标题。",
      },
      message: {
        type: "string",
        description: "通知正文。",
      },
      severity: {
        type: "string",
        enum: ["info", "warning", "critical"],
        description: "通知级别。",
        default: "info",
      },
      href: {
        type: "string",
        description: "可选跳转链接。",
      },
      targetUserId: {
        type: "string",
        description:
          "可选目标用户 ID。默认通知当前用户；只有受信任的系统 agent 或管理员可以通知其他用户。",
      },
    },
    required: ["title", "message"],
  },
};

const serverOnlyResult = (toolName: string) => ({
  rawData: {
    error: `${toolName} must run on the server-side agent runtime.`,
  },
  displayData: `${toolName} 需要在服务端 agent runtime 中执行。`,
});

export const queryModelUsageFunc = async () => serverOnlyResult("queryModelUsage");
export const createScheduledTaskFunc = async () => serverOnlyResult("createScheduledTask");
export const createDialogGoalFunc = async () => serverOnlyResult("createDialogGoal");
export const getDialogGoalFunc = async () => serverOnlyResult("getDialogGoal");
export const completeDialogGoalFunc = async () => serverOnlyResult("completeDialogGoal");
export const notifyUserFunc = async () => serverOnlyResult("notifyUser");
