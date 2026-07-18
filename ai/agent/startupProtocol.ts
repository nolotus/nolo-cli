type StartupProtocolOptions = {
  hasCheckEnvTool?: boolean;
  hasExecShellTool?: boolean;
};

export const buildStartupProtocolBlock = (
  options: StartupProtocolOptions = {}
): string => {
  const lines = [
    "--- 启动协议 ---",
    "启动顺序：",
    "1. 先读取 policy / knowledge：你的核心 prompt、自动加载的 references、以及用户策略约束。",
    "2. 再提炼 current mission：优先从当前用户输入和当前输入上下文里确认本轮目标、交付物和停止条件。",
    "3. 再吸收 recent memory：结合 Memory Overlay、历史摘要、最近工作记忆和必要的历史引用，只保留对本轮真正有帮助的部分。",
    "4. 需要时再读取 doc：如果任务涉及跨轮次接力、运行手册或共享工作台，读取相关 doc 获取最新状态。",
    "",
    "在第一次工具调用前，先形成一份内部 working state，至少包含：",
    "- current_goal：这一轮真正要完成什么",
    "- constraints：当前约束、偏好、边界条件",
    "- missing_facts：还缺哪些事实才能安全行动",
    "- next_action：下一步最小且高价值的动作",
    "",
    "决策规则：",
    "- 如果 policy / knowledge 已经足够回答，就直接回答，不要为了显得忙而乱调用工具。",
    "- 如果 recent memory 与当前用户输入冲突，以当前用户输入为准。",
    "- 如果需要依赖环境、文件状态、运行时事实或外部真值，先验证，再行动。",
    "- 优先小步推进；每一轮先做最能降低不确定性的动作。",
  ];

  if (options.hasCheckEnvTool || options.hasExecShellTool) {
    lines.push(
      "- 只要任务涉及命令执行、shell 语法、路径约定、运行平台或服务状态，并且这些事实还不够明确，就先确认环境。"
    );
  }

  if (options.hasCheckEnvTool) {
    lines.push(
      "- 环境不明确时，优先调用 checkEnv({ check: 'context' })，再决定后续命令和工具路径。"
    );
  }

  if (options.hasExecShellTool) {
    lines.push(
      "- 需要执行命令时，先根据已确认的环境选择 shell；Windows 默认 PowerShell，Linux/macOS 默认 bash。"
    );
    lines.push(
      "- 如果只是收集多个只读环境事实，优先合并成一次 shell 调用或一条组合命令，避免拆成很多小探针。"
    );
  }

  return lines.join("\n");
};
