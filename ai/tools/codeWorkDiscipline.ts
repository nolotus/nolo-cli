/**
 * 写代码时的操作纪律——**唯一真相源**。
 *
 * 这段文字以前存在两处、逐字抄了两份：
 *   - `TOOL_PACKS` 的「代码执行」能力包 promptPatch
 *   - `codingSkills` 的 coding skill promptPatch
 *
 * 而且已经在漂移：两份只差 H1 标题和两句补充说明（能力包那版多了「多会话共用
 * 一个 checkout」和「broader 测试失败是预存的」这两个理由），说明有人只改了
 * 其中一处。这正是 product-truth 里「同一件事不要两套表达 / 真相源唯一」要防的。
 *
 * 现在两边都引用本模块，各自只提供自己的 H1。内容有分歧时以这里为准。
 *
 * 独立成模块而不是塞进 toolPacks，是为了让 `ai/skills` 侧引用它时不必把整个
 * 能力包表拖进依赖图。
 */

/** 纪律正文（不含 H1，由调用方按自己的语境加标题）。 */
export const CODE_WORK_DISCIPLINE_BODY = `## 效率优先（省 token）
- 不复述需求，不解释「打算怎么做」，直接动手。改完只用一两句话说清「改了什么、去哪看」。
- 思考简短：定位问题即可，不做长篇推演。
- 小改动走最短路径：优先用 \`rg\` 搜代码/文本、\`find\`/\`fd\` 定位文件 → readFile 确认 → editFile 精确替换。能一次命中就不要反复读文件。
- 已经知道文件和位置时，跳过多余的 search/read，直接 edit。
- 禁止为一个小改动整页重写或连带改动未命中的部分。

## 代码修改纪律
- 编辑前先 readFile 确认当前内容，避免 stale hash 错误。
- 只碰任务书列出的文件；改完用 \`git status --short\` 自查，若改到清单外文件，如实报告。
- 不要 \`git add\` / \`git commit\` / \`git push\` / \`git stash\` / \`git reset\` / \`git checkout\` / \`git clean\`——改动留在工作区，提交由调用方验收后处理。仓库常有多个会话共用一个 checkout，你一提交就会把别人的在途文件卷进来。
- 只跑任务里列出的测试文件，不要跑 broader 测试（broaden 测试的失败是预存的，和你的改动无关）。
- 同一个文件读过一次后记住内容，不要重复读取。
- 如果 editFile 失败并提示 "expected 1 replacement but found 0"，先用 \`file <path>\` 检查是否有 CRLF。如果有，用 \`tr -d '\\r' < <path> > /tmp/clean.ts && mv /tmp/clean.ts <path>\` 转换后重试。
- 只读任务相关的文件，不要 grep 整个 repo 查找规则或配置。
- **建议汇报**：交付时把过程中发现的**任何值得用户知道的事**都列出来（预存无关改动、既有测试隔离问题、潜在风险、后续可优化点、需用户决策的事项），不要只报「做完了」。

## Review 纪律（commit 前硬门）
- 除 ≤2 步零逻辑风险的机械改动（错别字/格式/CSS 微调）外，所有代码变更 commit 前必须先派**其他 agent**（不同模型家族优先）review 工作区 diff（\`git diff\`，未提交的改动）。reviewer 不可是自己。无 review 不 commit——这是硬门，不是建议。
- 派发走 \`startAgentRun(agentKey, task, { ephemeral: true })\`（web/桌面端没有 nolo CLI，所有 host 都有这个工具）。ephemeral 让 review 完成后不留 dialog 记录。
- task 里必须写明审查对象（\`git diff\` 看工作区改动，或 \`git diff alpha...HEAD\` 看已提交改动），否则 reviewer 不知道审什么。
- 按角色加载对应 skill：reviewer 先 \`loadSkill("coding-review")\` 拿通用流程，再按角色 \`loadSkill("coding-review-<role>")\` 拿检查项。角色清单：code-quality（**必跑**）/ architecture（**单独派发**，中级以上问题）/ security（按需 + 安全敏感触发必跑）/ frontend-ux（涉及 UI 时）/ backend-data（涉及 server 时）。角色切割的目的是注意力隔离——每个角色只盯自己的检查面，按需启用，避免一个 reviewer 背所有角色导致注意力稀释。
- Verdict 标准：APPROVE（无 CRITICAL 或 HIGH）→ 可 commit；WARNING（仅 HIGH）→ 报告 owner 决定；BLOCK（有 CRITICAL）→ 必须先修。
- review 可能多轮收敛（有 finding→修→再审→直到 APPROVE）。每轮 review 是无上下文的——reviewer 只看当前工作区 diff，不带上一轮 finding 记忆。
- **自动 review 循环**：任务完成后**自动进入 review 循环**，不要停在「改完交付」就等调用方。流程：改完 → 派 reviewer 审工作区 diff → 若出 finding 就修复 → 复审 → 直到 APPROVE 才提交。除非调用方明确说「只改不审」，否则默认走完整循环。
- 若处于单 Agent 独占环境、其他 agent 不可达、或用户明确要求直接提交，允许带原因跳过（commit message 注明 [no-review: 原因]），但默认必须派 review。`;

/** 带标题的完整段落。 */
export const buildCodeWorkDiscipline = (heading: string): string =>
  `# ${heading}\n\n${CODE_WORK_DISCIPLINE_BODY}`;
