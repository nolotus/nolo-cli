// 文件路径: packages/ai/context/staleReplayGuard.ts
//
// Stale-replay guard：把历史摘要包进"仅历史参考，勿当活指令"的警告里注入。
//
// 动机：压缩恢复后或跨 dialog 继承时，模型可能把旧摘要里的 task 描述、
// skill 调用、ARGUMENTS= 载荷当成活指令重新执行，重复建 issue/分支/任务。
// ECC（everything-claude-code）踩过这个坑（anthropics/claude-code#1534），
// 用 "HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS" 包裹历史摘要。
//
// 实现已下沉到 `agent-runtime/staleReplayGuard`，因为桌面本地 runtime 也要
// 注入历史摘要，而 agent-runtime 必须保持宿主中立（不能反向依赖本包）。
// 这里保留 re-export，让既有 import 路径继续可用，同时保证**只有一份定义**——
// 两份拷贝靠人工同步迟早会漂移，而 guard 一旦漂移就会静默失去防重放能力。
//
// bun-nolo 注入历史摘要的四个点都用这同一个 wrapper：
//   1. buildSystemPrompt.ts 的 dialogSummary / proactiveSummary section
//   2. buildReferenceContext.ts 的 Passive/Proactive Summary
//   3. inheritedDialogPrompt.ts 的 checkpoint/passive/proactive summary
//   4. 桌面本地 runtime 的 dialog 摘要 layer（经 agent-runtime/turnContext）

export { wrapHistoricalSummaryWithReplayGuard } from "../../agent-runtime/staleReplayGuard";
