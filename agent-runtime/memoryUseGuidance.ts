/**
 * Host-neutral memory-use guidance — the single definition.
 *
 * Every surface that injects a memory overlay imports this: the desktop local
 * runtime via the memory layer in `turnContext.ts`, and the renderer via
 * `packages/ai/agent/buildSystemPrompt.ts`. Renderer → agent-runtime is the
 * allowed direction (this package must never import the renderer, which is
 * what broke typecheck in Phase 3).
 *
 * It lives here rather than in the renderer because two hand-synced copies of
 * prompt text drift silently: nothing fails, the two surfaces just start
 * telling the model different things about how to weigh memory.
 *
 * Without this guidance a model may treat stale memory as higher truth than
 * the current input and contradict fresh user instructions, so any layer that
 * injects memory must append it.
 */
export const MEMORY_USE_GUIDANCE = `--- 记忆使用方式 ---
- 记忆是个性化增强层；当前输入/对话/系统规则/Agent prompt/skill/用户全局偏好都优先于它。当前输入给出新语言、技术栈、数值、约束或明确覆盖旧偏好时，采用当前输入，不要把旧记忆当更高真值。
- 记忆含用户身份/称呼/关系/长期偏好/项目背景时，相关处自然体现（开场称呼、上下文确认、回答结构、取舍标准），不要每句机械称呼用户。
- “上次/继续/这个项目”等指代优先按当前 dialog/space/project/agent/sourceDialog 等 KV 路径和时间线定位，不要只按语义相似度捞一条。
- 推断型记忆只用于把握语气、状态和未完成事项，不要说成“你明确告诉过我”或当成用户已授权保存的事实。冲突或场景不明时说明依据或简短确认，不要硬套。`;