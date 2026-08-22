/**
 * rememberMemory 的 OpenAI function schema——唯一定义。
 *
 * 从 `rememberMemoryTool.ts` 抽出来是因为那个模块 import 了
 * `create/space/spaceSlice`（Redux）和 `./toolApiClient`，只有渲染进程能加载。
 * CLI/desktop 本地 runtime 需要同一份 schema 来向模型声明工具，但不能把
 * Redux 拖进 CLI bundle。
 *
 * 这里保持零依赖：任何 host 都可以直接 import。执行器各 host 自己接
 * （web 走 toolApiClient，CLI 走 /api/memory/remember 代理）。
 */
export const rememberMemoryFunctionSchema = {
  name: "rememberMemory",
  description: [
    "把值得长期记住的用户偏好、纠正、决策习惯或当前 Space 共识写成一条 memory。",
    "默认倾向于记：用户说出「记住/记得/别忘了/以后都/别再/我喜欢/我不喜欢/下次」这类话时，默认就调用本工具，不要反复自问是否够格。",
    "仍然不要记：一次性任务细节、当前任务进度、很快过期的事实。",
    "只有重复出现的可执行流程/排障步骤才传 kind=procedural；一般偏好和事实保持默认 episodic。",
    "scope 按内容性质选，不固定优先某一层：",
    "  - Space 协作约定/团队规则 → scope=space（当前 dialog 绑定 space 时）",
    "  - 用户个人身份或纯个人偏好 → scope=user（严格保存为用户主体）",
    "  - 与当前助手关系挂钩的偏好或有效做法 → scope=auto（runtime 使用当前 auto/fixed 助手主体）",
    "  - 当前任务的临时进度 → 不要调用，走对话上下文",
    "写成一句简洁、未来仍可理解的话。默认静默执行，不用向用户汇报已记住。",
    "",
    "【关键规则】日常错误记忆优先通过 rememberMemory 修正并降权（降低置信度）或归档，保留档案与解释链。",
    "【强制删除例外】仅在用户明确/强制要求删除且在用户自身权限范围内时，才允许执行物理删除（调用 deleteMemory，严格限制于当前用户拥有的记忆）。",
    "",
    "【置信度来源】每条记忆必须标注来源（供召回时判断可信度）：",
    "  - verified：工具/命令实测验证过（高置信度）",
    "  - stated：用户明确陈述（中高置信度）",
    "  - inferred：模型推断/凭印象，未验证（低置信度——容易编造，优先标记存疑）",
    "调用时尽量明确来源，无法判断的保守标 inferred。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "要记住的内容。请写成一句未来仍然可理解的简洁描述，例如“这个用户在复杂问题里更喜欢先看结论”。",
      },
      scope: {
        type: "string",
        enum: ["auto", "user", "space"],
        description:
          "记忆范围。Space 协作共识传 space；用户个人身份/偏好传 user；与当前助手关系挂钩的偏好传 auto。auto 时 runtime 使用当前 auto/fixed 助手主体。",
      },
      kind: {
        type: "string",
        enum: ["episodic", "semantic", "procedural"],
        description:
          "记忆类型。默认 episodic。只有重复出现的可执行流程、排障步骤或稳定 runbook 才使用 procedural。",
      },
    },
    required: ["content"],
  } as const,
};
