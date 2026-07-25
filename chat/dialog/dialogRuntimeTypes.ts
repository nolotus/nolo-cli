import type { Descendant } from "slate";

export const GLOBAL_DIALOG_RUNTIME_KEY = "__global__";

export interface PendingFile {
  id: string;
  name: string;
  /** Source content key included in the message attachment. */
  pageKey?: string;
  /** Source dialog key included in the message attachment. Prefer sourceDialogKey in new code. */
  dialogKey?: string;
  sourceDialogKey?: string;
  /** Target dialog runtime that should receive this pending attachment. */
  targetDialogKey?: string;
  /** @deprecated Use targetDialogKey. Kept for older pending attachment payloads. */
  runtimeDialogKey?: string;
  type:
    | "excel"
    | "docx"
    | "pdf"
    | "page"
    | "txt"
    | "dialog"
    | "table"
    | "image"
    | "file"
    | "agent"
    | "app"
    | "ocr_text";
  groupId?: string;
  ocrText?: string;
  /** 关联到文件处理状态（如 useMessageInputFiles 的 fileStatus）的跟踪 id。 */
  trackingId?: string;
}

export interface CreatePagePayload {
  slateData: Descendant[];
  jsonData?: Record<string, any>[];
  title: string;
  type: "excel" | "docx" | "pdf" | "txt" | "table";
  fileId: string;
  size: number;
  groupId?: string;
  dialogKey?: string;
}

export interface PendingRawData {
  pageKey: string;
  jsonData: Record<string, any>[];
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export type LoopStopReason =
  | "done"
  | "handoff"
  | "pending"
  | "timeout"
  | "error";
