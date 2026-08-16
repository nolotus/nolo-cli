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
    "- policy / knowledge 足够回答时直接回答，不要为了显得忙而乱调用工具。",
    "- recent memory 与用户输入冲突时，以当前用户输入为准。",
    "- 依赖外部环境、文件或事实时先验证再行动；小步推进，每轮做最能降低不确定性的动作。",
  ];

  if (options.hasCheckEnvTool || options.hasExecShellTool) {
    lines.push(
      "- 任务涉及命令执行、shell 语法、路径约定或服务状态且事实不明确时，先确认环境。"
    );
  }

  if (options.hasCheckEnvTool) {
    lines.push(
      "- 环境不明确时，优先调用 checkEnv({ check: 'context' })，再决定后续命令和工具路径。"
    );
  }

  if (options.hasExecShellTool) {
    lines.push(
      "- 执行命令时根据环境选 shell（Windows 默认 PowerShell，Linux/macOS 默认 bash）；收集多个只读事实优先合并为一次 shell 复合调用，避免拆成细碎探针。"
    );
  }

  return lines.join("\n");
};
