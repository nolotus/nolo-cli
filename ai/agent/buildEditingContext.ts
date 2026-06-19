// 文件路径: ai/agent/buildEditingContext.ts

import type { RootState } from "../../app/store";
import type { AgentRuntimeOptions } from "./types";
import { buildCanvasNodeEditingContextSummary } from "./canvasEditingContext";
import { selectCurrentTable, selectTableRows } from "../../render/table/tableSlice";
import { selectDoc } from "../../render/page/docSlice";

type AppConstraintPack = {
    id: string;
    title: string;
    rules: string[];
};

const buildAppConstraintPacks = (args: {
    framework: string;
    fileNames: string[];
    externalImports: string[];
}): AppConstraintPack[] => {
    const imports = new Set(args.externalImports);
    const fileSet = new Set(args.fileNames);
    const packs: AppConstraintPack[] = [
        {
            id: "repair-loop",
            title: "预检与定点修复",
            rules: [
                "每次改完代码后，先调用 appPreflight，只有预检通过后再调用 appDeploy。",
                "如果 preflight / deploy 失败，优先根据返回的 issues 做定点修复，然后重新 preflight；不要无关重写整页应用。",
                "如果工具结果里带有 repairPlan，默认立即执行 repairPlan 中的局部修复步骤，不要先停下来问用户。",
                "如果工具结果明确说明是 HTML / 非 JSON 响应、transport failure 或 retryable=false，停止自动 deploy 重试；这说明当前是平台通道异常，不是代码问题。",
            ],
        },
        {
            id: "design-system",
            title: "设计系统与小改动约束",
            rules: [
                "先检查当前应用是否已经有 theme / tokens / designSystem / 共享样式常量；如果已有，优先沿用这套设计系统，不要平行再造一套。",
                "如果当前应用还没有设计系统，而用户需求涉及 UI / 样式 / 新页面，优先补一层最小共享 token（colors、typography、spacing、radius、shadow），再让组件消费这些 token。",
                "如果当前应用是旧写法：视觉值散落在多个组件的硬编码 style / 常量里，而本次需求只是调字体、颜色、间距、圆角、阴影，默认执行一次最小 token 迁移，再在 token 层完成调整；不要继续把新数字散落写回多个位置。",
                "当用户只是想调字体大小、字重、颜色、圆角、阴影、间距等视觉参数时，优先修改 token 或命中的局部组件，不要顺手重写整个页面结构。",
                "除非用户明确要求整体改版或重做风格，否则不要连带修改布局、组件树、文案、数据流、路由或未命中的页面。",
                "如果只是小改一处，尽量把变更收敛在少数文件，并保持未命中文件的结构与命名稳定。",
            ],
        },
    ];

    if (args.framework === "react-spa" || fileSet.has("main.tsx") || fileSet.has("App.tsx")) {
        packs.push({
            id: "react-spa-core",
            title: "React SPA 形态保持",
            rules: [
                '继续沿用 framework: "react-spa" + files，不要退回单文件 Worker。',
                "保留稳定入口结构，优先维护 main.tsx + App.tsx，再局部修改组件文件。",
            ],
        });
    }

    if (imports.has("react-icons/lu")) {
        packs.push({
            id: "react-icons-lu",
            title: "Lucide 图标安全规则",
            rules: [
                "只能使用 react-icons/lu 中真实存在的图标名，不要猜测变体名。",
                "如果不确定图标名，优先使用 LuCircle、LuCheck、LuX、LuInfo、LuArrowRight 这类基础图标。",
            ],
        });
    }

    if (imports.has("leaflet") || imports.has("react-leaflet")) {
        packs.push({
            id: "leaflet",
            title: "Leaflet 地图约束",
            rules: [
                "不要手动 import leaflet.css；平台会自动注入 Leaflet 样式。",
                "修改地图时优先保留现有坐标、缩放和图层结构，只做必要的交互或视觉调整。",
            ],
        });
    }

    if (imports.has("@xyflow/react")) {
        packs.push({
            id: "xyflow",
            title: "Flow 图编辑约束",
            rules: [
                "不要新增外部 CSS import；需要样式时直接补最小必要内联样式或组件内 style 标签。",
                "优先复用现有节点/边数据结构，避免重写整套 flow 画布。",
            ],
        });
    }

    if (imports.has("echarts") || imports.has("echarts-for-react")) {
        packs.push({
            id: "echarts",
            title: "图表改动约束",
            rules: [
                "优先局部修改 option 配置、数据映射和组件 props，不要重写整个图表页面。",
                "响应式布局优先靠容器尺寸和现有组件结构调整，不要额外引入 CSS 文件。",
            ],
        });
    }

    if (imports.has("docx") || imports.has("xlsx")) {
        packs.push({
            id: "file-processing",
            title: "文档/表格处理约束",
            rules: [
                "不要把大型数据或模板内容直接内嵌进代码常量；优先保留运行时加载方式。",
                "修改导入导出逻辑时，优先沿用现有文件处理链路和数据结构。",
            ],
        });
    }

    return packs;
};

const formatAppConstraintPacks = (packs: AppConstraintPack[]): string[] => {
    if (packs.length === 0) return [];

    return [
        "",
        "当前激活约束包（按当前应用依赖/形态动态注入）：",
        ...packs.flatMap((pack) => [
            `- ${pack.title}（${pack.id}）`,
            ...pack.rules.map((rule) => `  - ${rule}`),
        ]),
    ];
};

/**
 * 根据当前 Redux 状态 + 本次调用的 runtimeOptions，生成「当前编辑对象」的自然语言描述。
 *
 * 设计目标：
 * - 只返回一段 string 或 null，不关心 Prompt 结构。
 * - 不涉及任何持久化（DialogConfig / AgentConfig），完全是运行时。
 * - 目前重点支持:
 *   - kind === "table": 当前表格 + 部分行数据
 *   - kind === "page" | "article": 当前页面/文章的标题（正文后面可以再丰富）
 */
export const buildEditingContextSummary = (
    state: RootState,
    runtimeOptions?: AgentRuntimeOptions
): string | null => {
    const targetKind = runtimeOptions?.editingTarget?.kind;

    // 1) 表格场景：基于当前表 meta + 行数据
    if (targetKind === "table") {
        const table = selectCurrentTable(state);
        const rows = selectTableRows(state);
        const metadata = runtimeOptions?.editingTarget?.metadata;
        const focusContext =
            metadata && typeof metadata === "object" ? metadata.focusContext : null;


        if (!table) return null;


        const columns = Array.isArray(table.columns) ? table.columns : [];


        const columnSummaries = columns.length
            ? columns.map((c) => {
                const displayName = c.label || c.name;
                const type = c.type || "text";
                const requiredFlag = c.required ? "必填" : "可选";
                const primaryFlag = c.isPrimary ? "，主字段" : "";
                const optionsStr =
                    Array.isArray(c.options) && c.options.length
                        ? `，可选值：${c.options.join(" | ")}`
                        : "";
                const descStr = c.description ? `。说明：${c.description}` : "";


                return `- ${c.name}（显示名：${displayName}，类型：${type}，${requiredFlag}${primaryFlag}${optionsStr}${descStr}）`;
            })
            : ["- (当前表尚未定义字段)"];


        // 只给出前 20 行作为结构示例，避免 prompt 过长
        const sampleRows = Array.isArray(rows) ? rows.slice(0, 20) : [];
        const rowsPreview = sampleRows.length
            ? JSON.stringify(sampleRows, null, 2)
            : "(当前表暂无行数据)";


        const tableTitle = table.displayName ?? table.tableId ?? "(未命名表)";
        const tableDesc = table.description
            ? `用途说明：${table.description}`
            : "(暂无用途说明)";


        // ✅ 新增：如果有表级 tags，把它们也告诉 Agent
        const tableTagsLine =
            Array.isArray(table.tags) && table.tags.length
                ? `- 关键词标签: ${table.tags.join(", ")}`
                : null;


        return [
            "当前编辑目标：一张数据表（Editing Table）。",
            `- 表 ID: ${table.tableId}`,
            `- 显示名称: ${tableTitle}`,
            `- ${tableDesc}`,
            ...(tableTagsLine ? [tableTagsLine] : []),
            ...(focusContext &&
                typeof focusContext === "object" &&
                "columnName" in focusContext
                ? [
                    "",
                    "当前焦点（Focus Context）：",
                    `- 当前单元格列: ${String((focusContext as any).columnName ?? "(未知列)")}`,
                    ...((focusContext as any).rowTitle
                        ? [`- 当前行标题: ${String((focusContext as any).rowTitle)}`]
                        : []),
                    ...((focusContext as any).rowIndex !== null &&
                        (focusContext as any).rowIndex !== undefined
                        ? [`- 当前行号: ${Number((focusContext as any).rowIndex) + 1}`]
                        : []),
                    ...((focusContext as any).cellPreview
                        ? [`- 当前单元格内容预览: ${String((focusContext as any).cellPreview)}`]
                        : []),
                  ]
                : []),
            "",
            "字段定义（Field Schema）：",
            ...columnSummaries,
            "",
            "【给 AI 的操作指南 / 非用户原话】",
            "当用户希望在当前表中“新增一行 / 新增记录 / 插入一条 / 帮我记一条 xxx”时：",
            "1. 必须调用工具 addTableRow（而不是只在回答中口头描述要新增的数据）。",
            "2. 调用 addTableRow 时：",
            "   - 使用参数 values（一个对象），其中每个 key 必须是上面字段名之一（name，而不是 label）。",
            '   - 例如：{"values":{"title":"修 Bug #123","status":"todo","note":"高优先级"}}。',
            "   - 尽量从用户的自然语言中推断并填满所有相关字段；对于必填字段（required=true）尤其要注意。",
            '   - 用户没有提到的字段，可以使用空字符串 "" 或 null 作为占位。',
            "   - 绝不要传入空对象 {} 作为 values。",
            "",
            "以下是部分示例行（最多 20 行，用于帮助你理解列含义，请避免在回答中完整粘贴整表）：",
            rowsPreview,
        ].join("\n");
    }




    // 2) 页面 / 文章场景：先只提供标题信息（正文后面可以在这里丰富）
    if (targetKind === "page" || targetKind === "article") {
        const page = selectDoc(state);
        const metadata = runtimeOptions?.editingTarget?.metadata;
        const focusContext =
            metadata && typeof metadata === "object" ? metadata.focusContext : null;
        if (!page) return null;

        const title = page.title ?? "(未命名页面)";

        return [
            "当前编辑目标：一个页面 / 文章（Editing Document）。",
            `- 标题: ${title}`,
            ...(focusContext &&
                typeof focusContext === "object" &&
                "anchorPath" in focusContext
                ? [
                    "",
                    "当前焦点（Focus Context）：",
                    `- 光标是否折叠: ${Boolean((focusContext as any).isCollapsed) ? "是" : "否"}`,
                    ...((focusContext as any).blockType
                        ? [`- 当前块类型: ${String((focusContext as any).blockType)}`]
                        : []),
                    ...((focusContext as any).selectedText
                        ? [`- 当前选中文本: ${String((focusContext as any).selectedText)}`]
                        : []),
                    ...((focusContext as any).anchorPath?.length
                        ? [`- 当前锚点路径: ${(focusContext as any).anchorPath.join(" > ")}`]
                        : []),
                  ]
                : []),
            "",
            "如果用户要求你对这篇文章进行修改或优化，请在回答中明确指出修改方向。",
            "如果存在当前选区或光标上下文，优先围绕该局部位置做定点改写，而不是泛泛重写整篇文档。",
        ].join("\n");
    }

    if (targetKind === "app") {
        const editingTarget = runtimeOptions?.editingTarget;
        const metadata = editingTarget?.metadata;
        const appId = editingTarget?.key ?? "(未知 appId)";
        const title = editingTarget?.title ?? "(未命名应用)";
        const framework =
            typeof metadata?.framework === "string"
                ? metadata.framework
                : "worker";
        const appUrl =
            typeof metadata?.appUrl === "string" ? metadata.appUrl : null;
        const fileNames = Array.isArray(metadata?.fileNames)
            ? metadata.fileNames.filter((name): name is string => typeof name === "string")
            : [];
        const externalImports = Array.isArray(metadata?.externalImports)
            ? metadata.externalImports.filter(
                (name): name is string => typeof name === "string"
            )
            : [];
        const sourceSummary =
            typeof editingTarget?.summary === "string" && editingTarget.summary.trim()
                ? editingTarget.summary.trim()
                : null;
        const constraintPacks = buildAppConstraintPacks({
            framework,
            fileNames,
            externalImports,
        });

        return [
            "当前编辑目标：一个 Web 应用（Editing App）。",
            `- 应用 ID: ${appId}`,
            `- 名称: ${title}`,
            `- 技术形态: ${framework}`,
            ...(appUrl ? [`- 当前访问地址: ${appUrl}`] : []),
            ...(fileNames.length
                ? [`- 当前源码文件: ${fileNames.join(", ")}`]
                : ["- 当前源码文件: (未提供多文件清单；可能是单文件源码，也可能只剩部署产物)"]),
            ...(externalImports.length
                ? [`- 当前依赖白名单命中: ${externalImports.join(", ")}`]
                : []),
            ...(sourceSummary ? ["", sourceSummary] : []),
            "",
            "【给 AI 的操作指南 / 非用户原话】",
            "1. 用户要求修改当前应用时，先调用 appRead 获取当前代码/文件，再基于现有实现修改。",
            "2. 如果 appRead 返回 workspaceRef/sourceFiles/sourceOmitted，不要整站重写；使用 App Builder 的受限 workspace 文件工具：appFileList=listFiles、appFileSearch=searchFiles、appFileRead=readFile、appFileReplace=editFile、appFileWrite=writeFile。先定位文件与命中行，大文件只读取必要行范围；文字、样式、token、局部逻辑等小改动必须优先用 appFileReplace 精确替换唯一片段，只有新建文件或确实需要整文件重写时才用 appFileWrite。",
            "3. 先识别当前应用是否已有 theme / tokens / design system；已有就优先改这层，没有再补一层最小共享 token，再基于 token 调整组件。",
            "4. 如果当前应用还是旧写法：视觉值散落在组件硬编码 style 里，而用户只是做字体/颜色/间距等视觉微调，默认先把命中的视觉值抽到最小 token 层，再完成本次修改；除非用户明确要求不要重构。",
            `5. 重新部署当前应用时，appDeploy 必须继续传同一个 appId（${appId}），避免创建新应用。`,
            framework === "nolo-react"
                ? '6. 当前应用是 Nolo React SSR，修改时优先使用受限 app workspace 文件工具操作源码工作区，然后 appPreflight/appDeploy；不要退回 react-spa 或单文件 Worker。'
                : framework === "react-spa"
                  ? '6. 当前应用是 React SPA，修改时继续沿用 framework: "react-spa" + files，不要退回单文件 Worker。'
                  : "6. 当前应用目前是 Worker 形态；如果需求变成复杂交互或图表，可以评估升级为 React SPA。",
            ...(fileNames.length
                ? []
                : [
                    "7. 当前没有源码文件清单时，必须先用 appRead 判断读到的是可维护源码还是部署产物 / 打包 bundle。",
                    "8. 如果 appRead 返回的是 HTML 壳、importmap、压缩 bundle 或明显不是原始源码文件，禁止在未告知用户风险的情况下整站重写；应先说明“当前缺少原始源码快照，继续修改更像整体重建”，等用户确认后再继续。",
                ]),
            "9. 如果用户只是要调字体大小、配色、圆角、阴影、留白等视觉细节，默认优先改设计 token 或命中的局部组件；对旧写法应用则优先做最小 token 迁移，不要只改散落硬编码。",
            "10. 每次修改完成后，先 appPreflight，再 appDeploy；如果失败，按返回 issues 定点修复。",
            "11. 回复用户时优先说明做了什么变化、现在应用可以怎么用，而不是直接堆代码。",
            ...formatAppConstraintPacks(constraintPacks),
        ].join("\n");
    }

    if (targetKind === "image" || targetKind === "file") {
        const editingTarget = runtimeOptions?.editingTarget;
        const metadata = editingTarget?.metadata;
        const title = editingTarget?.title ?? "(未命名对象)";
        const objectKey = editingTarget?.key ?? "(未知 key)";
        const fileId =
            typeof metadata?.fileId === "string" ? metadata.fileId : null;
        const url = typeof metadata?.url === "string" ? metadata.url : null;
        const size =
            typeof metadata?.size === "number" ? metadata.size : null;

        return [
            `当前编辑目标：一个${targetKind === "image" ? "图片" : "文件"}对象（Editing ${targetKind === "image" ? "Image" : "File"}）。`,
            `- 对象 key: ${objectKey}`,
            `- 标题: ${title}`,
            ...(fileId ? [`- fileId: ${fileId}`] : []),
            ...(url ? [`- 资源地址: ${url}`] : []),
            ...(size !== null ? [`- 文件大小: ${size} bytes`] : []),
            "",
            "【给 AI 的操作指南 / 非用户原话】",
            targetKind === "image"
                ? "当前阶段优先帮助用户理解图片内容、提炼重点、命名归类和下一步处理建议。不要假装已经完成复杂图片编辑。"
                : "当前阶段优先帮助用户理解文件用途、提取处理思路、给出整理建议和下一步操作建议。不要假装已经完整解析文件内容。",
        ].join("\n");
    }

    if (targetKind === "canvas_node") {
        return buildCanvasNodeEditingContextSummary(runtimeOptions);
    }

    // 其它 kind 以后按需扩展
    return null;
};
