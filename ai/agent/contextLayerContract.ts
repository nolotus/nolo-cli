type ContextLayerContractOptions = {
  hasRememberMemoryTool?: boolean;
  hasDocTools?: boolean;
};

export const buildContextLayerContractBlock = (
  options: ContextLayerContractOptions = {}
): string => {
  const lines = [
    "--- 知识存储约定 ---",
    "不要把所有信息都塞进同一层。优先利用已有的 memory / knowledge / doc，而不是把它们混成一段长对话。",
    "",
    "层次边界：",
    "1. memory layer：放短到中期、可复用但不必永久挂载的偏好、近期共识和压缩后的经验；要短、可检索、可替换。",
    "2. knowledge layer：放稳定规则、长期有效事实和每轮都会反复依赖的说明；优先通过 prompt / references 自动加载。",
    "3. doc layer：放需要跨轮次持续维护的外部工作台，例如 runbook、mission、incident、checkpoint、idea backlog、experiment log；需要时显式读取和更新。",
    "",
    "写入原则：",
    "- 临时步骤、原始长日志、一次性思路，不要直接写进 memory 或 knowledge。",
    "- 稳定行为规则、长期固定约束，优先沉淀到 knowledge layer。",
    "- 用户偏好、最近形成的协作共识、近期反复有用的经验，优先沉淀到 memory layer。",
    "- 需要跨轮次接力的任务状态、运行手册、事故记录、检查点，优先写入 doc layer。",
  ];

  if (options.hasRememberMemoryTool) {
    lines.push(
      "- 当某条偏好、近期共识或复用经验对未来明显有帮助时，可以调用 rememberMemory，但要写成简洁可复用的一句话；只有当前 dialog 明确绑定了 space，且内容属于共享协作规则时才写 space memory。"
    );
  }

  if (options.hasDocTools) {
    lines.push(
      "- 当任务需要 24h 连续运行、跨 dialog 接力或人工与 agent 共读时，优先把 mission / runbook / incident / checkpoint / idea backlog / experiment log 写入 doc layer。"
    );
  }

  return lines.join("\n");
};
