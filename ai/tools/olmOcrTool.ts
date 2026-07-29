import { callToolApi } from "./toolApiClient";

export const olmOcrSchema = {
    name: "olm_ocr",
    description: "使用 allenai/olmOCR-2-7B-1025 模型进行光学字符识别 (OCR)。适合文档、论文等结构化文本的高质量识别。",
    parameters: {
        type: "object",
        properties: {
            imageUrl: {
                type: "string",
                description: "要进行 OCR 的图片 URL、base64 编码的图片数据，或者内部文件 ID (如 'file-...')。",
            },
            prompt: {
                type: "string",
                description: "可选的提示词，用于指导模型如何提取信息（例如：'提取所有表格数据' 或 '识别图片中的所有文字'）。默认为 '识别图片中的所有文字'。",
                default: "识别图片中的所有文字"
            }
        },
        required: ["imageUrl"],
    },
};

export const olmOcrFunc = async (input: any, thunkApi: any): Promise<any> => {
    const { imageUrl, prompt = "识别图片中的所有文字" } = input;

    const data = await callToolApi(thunkApi, "/api/olm-ocr", { imageUrl, prompt }, { withAuth: true });

    return {
        summary: "OCR processing completed",
        text: data.choices?.[0]?.message?.content || "No text detected",
        rawData: data
    };
};
