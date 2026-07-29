// 文件路径: packages/ai/tools/codeTools.ts

import {
    readFileFunctionSchema,
    readFileFunc,
    readFilePreviewFunc,
} from "./readFileTool";
import {
    writeFileFunctionSchema,
    writeFileFunc,
    writeFilePreviewFunc,
} from "./writeFileTool";

import {
    codeSearchFunctionSchema,
    codeSearchFunc,
} from "./codeSearchTool";
import {
    applyEditFunctionSchema,
    applyEditFunc,
} from "./applyEditTool";
import {
    applyLineEditsFunctionSchema,
    applyLineEditsFunc,
} from "./applyLineEditsTool";


import type { ToolDefinition } from "./index";

export const codeToolDefinitions: ToolDefinition[] = [
    {
        id: "readFile",
        schema: readFileFunctionSchema,
        executor: readFileFunc,
        previewExecutor: readFilePreviewFunc,
        description: {
            name: "readFile",
            description:
                "读取项目中的指定文本文件的完整内容，常用于在修改前先查看代码。",
            category: "代码 / 文件操作",
        },
        behavior: "data",
        uiGroup: "data",
    },
    {
        id: "writeFile",
        schema: writeFileFunctionSchema,
        executor: writeFileFunc,
        previewExecutor: writeFilePreviewFunc,
        description: {
            name: "writeFile",
            description:
                "在项目中创建或覆盖一个文件的完整内容，适合新建文件或整文件重写。",
            category: "代码编辑",
        },
        behavior: "action",
        cancelable: true,
        uiGroup: "data",
    },
    {
        id: "applyEdit",
        schema: applyEditFunctionSchema,
        executor: applyEditFunc,
        description: {
            name: "applyEdit",
            description:
                "基于精确文本片段执行局部代码修改，默认唯一匹配，适合作为首选编辑工具。",
            category: "代码编辑",
        },
        behavior: "action",
        cancelable: true,
        uiGroup: "data",
    },

    {
        id: "codeSearch",
        schema: codeSearchFunctionSchema,
        executor: codeSearchFunc,
        description: {
            name: "codeSearch",
            description: "基于 rg 搜索代码内容或列出文件，统一替代旧的 searchRepo/listFiles。",
            category: "代码分析",
        },
        behavior: "data",
        uiGroup: "data",
    },
    {
        id: "applyLineEdits",
        schema: applyLineEditsFunctionSchema,
        executor: applyLineEditsFunc,
        description: {
            name: "applyLineEdits",
            description:
                "对指定代码文件按行号执行精确的文本编辑操作，适合 applyEdit 不方便表达的局部修改。",
            category: "代码编辑",
        },
        behavior: "action",
        cancelable: true,
        uiGroup: "data",
    },
];
