// /ai/tools/generateDocxTool.ts

/**
 * 供调用方 / LLM 使用的入参类型
 */
export interface GenerateDocxArgs {
  templateUrl: string;
  fileName?: string;
  variables?: Record<string, any>;
  /**
   * 是否把变量字符串中的 \n 转成 Word 里的换行。
   * - 默认为 true，保持和之前行为一致
   * - 如果希望表格尽量由 Word 自己控制自动换行 / 调整宽度，可以在调用时传 false
   */
  respectLineBreaks?: boolean;

  /**
   * 是否对备注类字段（remark）做一层“去换行、去多余空白”的清洗。
   * - 默认为 true，有利于启用“根据内容调整表格大小”的表格自动拉宽备注列
   */
  normalizeRemark?: boolean;
}

/**
 * LLM 用的 schema：告诉它有哪些参数可以传
 * 约定：模板里的占位符使用 [[name]] 这种形式，而不是 {{name}}
 */
export const generateDocxFunctionSchema = {
  name: "generateDocx",
  description:
    "在浏览器中根据指定的 DOCX 模板 URL 和变量，生成并下载一个新的 DOCX 文档。模板占位符使用 [[name]] 语法。",
  parameters: {
    type: "object",
    properties: {
      templateUrl: {
        type: "string",
        description: "DOCX 模板文件的 URL，例如 /templates/contract.docx。",
      },
      fileName: {
        type: "string",
        description: "生成文档的文件名（不含 .docx 后缀，可选，默认：文档）。",
      },
      variables: {
        type: "object",
        description:
          "用于替换模板占位符的键值对，例如 { contract_no: 'PO2501', product_name: '中号转盘款拼图板' }。",
        additionalProperties: true,
      },
      respectLineBreaks: {
        type: "boolean",
        description:
          "是否保留变量字符串中的换行符 (\\n) 为 Word 中的换行。默认 true。若设为 false，则更有利于让 Word 自己控制表格列宽与自动换行。",
      },
      normalizeRemark: {
        type: "boolean",
        description:
          "是否对备注字段（如 remark）做清洗：去掉内部换行和多余空白，提升“根据内容调整表格大小”时备注列的表现。默认 true。",
      },
    },
    required: ["templateUrl"],
  },
};

/**
 * 针对 remark 这类长文本字段的清洗：
 * - 统一换行符格式
 * - 把换行整体压成一个空格（避免变成硬换行）
 * - 收敛多余空白，保留语义
 */
function normalizeRemarkText(raw: string): string {
  let text = raw;

  // 统一换行符为 \n
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 将若干个换行（两边可能带空白）压成一个空格
  text = text.replace(/\s*\n+\s*/g, " ");

  // 将多个连续空格（含不可见空格）压成单个普通空格
  text = text.replace(/[ \t\u00A0]+/g, " ");

  return text.trim();
}

/**
 * 通用变量清洗：
 * - 统一字符串里的换行符
 * - 去掉末尾多余空白
 * - 针对 remark 字段做额外处理（去换行、去多余空白）
 */
function normalizeVariables(
  vars: Record<string, any> | undefined,
  options: { normalizeRemark: boolean }
): Record<string, any> {
  if (!vars) return {};

  const { normalizeRemark } = options;
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === "string") {
      const unified = value
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trimEnd();

      if (normalizeRemark && key === "remark") {
        result[key] = normalizeRemarkText(unified);
      } else {
        result[key] = unified;
      }
    } else {
      // 非字符串保持原样（数字、数组、对象等）
      result[key] = value;
    }
  }

  return result;
}

/**
 * 在前端用 docxtemplater 生成 docx 并触发浏览器下载
 * 模板中请使用 [[variable_name]] 作为占位符，避免和已有的 {{ }} 冲突
 */
export async function generateDocxFunc(
  args: GenerateDocxArgs,
  _thunkApi: any
): Promise<{ rawData: object; displayData: string }> {
  const templateUrl = args.templateUrl?.trim();
  if (!templateUrl) {
    throw new Error("生成文档失败：templateUrl 不能为空。");
  }

  const fileName = (args.fileName?.trim() || "文档") + ".docx";

  // 默认：保留换行；对 remark 做清洗
  const respectLineBreaks = args.respectLineBreaks ?? true;
  const normalizeRemark = args.normalizeRemark ?? true;

  // 在传给 docxtemplater 之前，先做一层变量清洗
  const variables = normalizeVariables(args.variables, { normalizeRemark });

  try {
    const [{ default: PizZip }, { default: Docxtemplater }] = await Promise.all([
      import("pizzip"),
      import("docxtemplater"),
    ]);

    // 1. 拉取模板
    const res = await fetch(templateUrl);
    if (!res.ok) {
      throw new Error(`无法加载模板：${templateUrl}`);
    }
    const arrayBuffer = await res.arrayBuffer();

    // 2. 用 PizZip 打开 docx
    const zip = new PizZip(new Uint8Array(arrayBuffer));

    // 3. 创建 docxtemplater 实例
    // 这里显式改用 [[ ]] 作为分隔符，避免解析到历史留下的 {{ }} 残骸
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      // 是否把字符串里的 \n 转成 Word 中的换行（<w:br/>）
      linebreaks: respectLineBreaks,
      delimiters: {
        start: "[[",
        end: "]]",
      },
    });

    // 4. 设置数据并渲染
    doc.setData(variables);

    try {
      doc.render();
    } catch (e: any) {
      console.error("docxtemplater 渲染错误:", e);
      if (e?.properties?.errors) {
        e.properties.errors.forEach((err: any) =>
          console.error("template error:", err)
        );
      }
      throw new Error("模板渲染失败，请检查占位符和 variables 是否匹配。");
    }

    // 5. 生成 Blob 并触发浏览器下载
    const blob = doc.getZip().generate({
      type: "blob",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // 6. 返回给 LLM / 前端展示的信息
    const rawData = {
      success: true,
      fileName,
      persisted: false, // 仅本地下载，未持久化到服务端
    };
    const displayData = `文档《${fileName}》已生成并开始下载。`;

    return { rawData, displayData };
  } catch (error: any) {
    const msg = error?.message || JSON.stringify(error) || "未知错误";
    throw new Error(`生成文档时出错: ${msg}`);
  }
}
