/**
 * createWorkflow tool
 *
 * LLM calls this ONCE to define and immediately execute a workflow.
 * The execution engine runs all steps deterministically — no further
 * LLM involvement needed for orchestration, so token cost is O(1)
 * regardless of step count.
 *
 * Use when the task path is known upfront.
 * Use agent loop when the path needs dynamic discovery.
 */

import { runWorkflow } from "../workflow/workflowExecutor";
import type {
  WorkflowDefinition,
  WorkflowStep,
} from "../workflow/workflowTypes";

export const createWorkflowFunctionSchema = {
  name: "createWorkflow",
  description:
    "当你已知完整执行路径时使用本工具。定义一个多步骤 workflow，引擎自动执行全部步骤，" +
    "不需要每步都调用 LLM 决策，大幅节省 token。" +
    "步骤类型：" +
    "'tool'——直接执行注册工具；" +
    "'llm'——单次 LLM 调用（无 tool loop）；" +
    "'parallel'——子步骤并发执行；" +
    "'condition'——纯逻辑判断分支，无需 LLM。" +
    "步骤间通过 {{steps.STEP_ID.result}} 传递数据。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Workflow 标题，简明描述整体目标。",
      },
      steps: {
        type: "array",
        description: "有序步骤列表。每步声明类型和所需参数，引擎顺序执行（parallel 步骤内部并发）。",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "步骤唯一 ID，后续步骤通过 {{steps.ID.result}} 引用。",
            },
            type: {
              type: "string",
              enum: ["tool", "llm", "parallel", "condition"],
              description: "步骤类型。",
            },
            title: {
              type: "string",
              description: "步骤人类可读描述（可选）。",
            },
            // tool step
            tool: {
              type: "string",
              description: "type='tool' 时必填，工具名称。",
            },
            args: {
              type: "object",
              description:
                "type='tool' 时必填，工具参数。支持 {{steps.ID.result}} 和 {{steps.ID.result[N]}} 占位符。" +
                "parallel 子步骤结果也可直接通过其自身 ID 引用，例如 {{steps.subStepId.result}}。",
            },
            // llm step
            prompt: {
              type: "string",
              description: "type='llm' 时必填，发送给模型的 prompt。支持占位符。",
            },
            model: {
              type: "string",
              description: "type='llm' 时可选，指定模型名。",
            },
            // parallel step
            steps: {
              type: "array",
              description:
                "type='parallel' 时必填，子步骤列表（tool 或 llm 类型），并发执行。" +
                "子步骤执行完成后，其结果同时以子步骤自身 ID 注册到全局 steps map，" +
                "后续步骤可通过 {{steps.subStepId.result}} 直接引用，无需通过父 parallel 步骤中转。",
              items: { type: "object" },
            },
            // condition step
            check: {
              type: "string",
              description:
                "type='condition' 时必填，纯 JS 布尔表达式。" +
                "steps.<stepId>.<prop> 表示某步骤结果的属性（点路径，不支持 bracket notation，无 .result 包装）。" +
                "支持：点路径 / 字符串和数字字面量 / 布尔 null / 比较运算符 === !== > < >= <= / 逻辑运算符 && || ! / 括号。" +
                "例: \"steps.validate.isValid === true\" 或 \"steps.score.value >= 80 && steps.flag.ok !== false\"",
            },
            ifTrue: {
              type: "array",
              items: { type: "string" },
              description: "条件为真时执行的步骤 ID 列表，其余步骤跳过。",
            },
            ifFalse: {
              type: "array",
              items: { type: "string" },
              description: "条件为假时执行的步骤 ID 列表，其余步骤跳过。",
            },
            // error handling
            onError: {
              type: "string",
              enum: ["stop", "skip", "retry"],
              description:
                "步骤失败时策略：stop（默认，终止 workflow）/ skip（跳过，结果记为 null 继续）" +
                "/ retry（按 retryCount 次数重试，耗尽后若仍失败则触发 stop）。",
            },
            retryCount: {
              type: "integer",
              description: "onError='retry' 时重试次数，默认 1（即最多执行 2 次）。",
            },
          },
          required: ["id", "type"],
        },
      },
    },
    required: ["title", "steps"],
  },
};

interface CreateWorkflowArgs {
  title: string;
  steps: WorkflowStep[];
}

export async function createWorkflowFunc(
  args: CreateWorkflowArgs,
  thunkApi: any
): Promise<{ rawData: any; displayData?: string }> {
  const { title, steps } = args;

  if (!steps?.length) {
    throw new Error("createWorkflow: steps 不能为空。");
  }

  const definition: WorkflowDefinition = { title, steps };

  const { dispatch } = thunkApi;
  const result = await dispatch(runWorkflow({ definition })).unwrap();

  const completedCount = Object.values(result.results).filter(
    (v) => v !== null && v !== undefined
  ).length;

  const displayData = result.success
    ? `✅ **${title}** 完成，共执行 ${completedCount} 步`
    : `❌ **${title}** 在步骤 \`${result.failedStep}\` 失败：${result.error}`;

  return { rawData: result, displayData };
}
