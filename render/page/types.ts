import { DataType } from "../../create/types"; // 确认路径
import type { PageSkillMetadata } from "../../ai/skills/skillDocProtocol";
import type { ContentIcon } from "../contentIcon/types";

export interface PageData {
  id: string; // 通常与 pageKey 中的 id 部分相同
  dbKey: string; // pageKey (例如 'page-userid-ulid')
  type: DataType.DOC | DataType.FILE | DataType.IMAGE;
  title: string;
  content?: string | null; // 只读展示 markdown 缓存 / legacy bridge，不是真源
  slateData?: any | null; // 文档真源
  spaceId: string | null; // 页面所属的 spaceId, null 表示不在任何空间
  tags?: string[]; // 页面的标签
  icon?: ContentIcon | null;
  created: string; // ISO 格式创建时间
  updated_at?: string; // ISO 格式更新时间 (可选)
  tools?: string[]; // 关联的工具列表
  meta?: PageSkillMetadata;
}
