// 文件路径: render/page/createPageAction.ts
import { selectIdentityUserId } from "identity/selectors";
import {
  addContentToSpace,
  selectCurrentSpaceId,
} from "../../create/space/spaceSlice";
import { createPageKey } from "../../database/keys";
import i18n from "../../app/i18n/client";
import { DataType } from "../../create/types";
import type { RootState, AppDispatch } from "../../app/store";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { write } from "../../database/dbSlice";
import type { PageData } from "./types";

// 新增：把 markdown 转为 Slate 的工具 & 类型
import { markdownToSlate } from "../../create/editor/transforms/markdownToSlate";
import {
  createEmptyParagraph,
  splitSlateTitleAndBody,
  type EditorContent,
} from "../../create/editor/utils/slateUtils";
import { slateToRenderMarkdown } from "../../create/editor/transforms/slateToRenderMarkdown";
import { parseSkillDocProtocol } from "../../ai/skills/skillDocProtocol";
import { buildSkillSummaryMarker } from "../../ai/skills/skillSummaryMarker";

/**
 * 归一化 / 过滤 categoryId
 *
 * 设计目标：
 * - 允许正常的、看起来像 ID 的字符串通过；
 * - 对 AI 乱编的 “读书笔记分类” / “分类一” / 超短数字 等，直接当成 undefined。
 *
 * 注意：这里的规则可以按你实际的 ID 生成规则调整。
 */
const normalizeCategoryId = (raw?: string): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  // 1) 过滤掉包含空格或非 ASCII 字符的情况
  //    比如 “读书笔记分类” 会被直接判为无效
  const asciiNoSpace = /^[\x20-\x7E]+$/; // 可见 ASCII 字符
  if (!asciiNoSpace.test(trimmed)) return undefined;

  // 2) 简单做个长度下限，避免 "1"、"abc" 这种明显不是 ID 的值
  //    如果你的真实 ID 很短，可以把 8 调小一点
  if (trimmed.length < 8) return undefined;

  // 3) 如果你有更具体规则（如 UUID / nanoid），可以在这里再加一层匹配
  // const idLike = /^[0-9a-zA-Z_-]{10,64}$/;
  // if (!idLike.test(trimmed)) return undefined;

  return trimmed;
};

export const createPageAction = async (
  {
    categoryId,
    spaceId: customSpaceId,
    title: initialTitle,
    addMomentTag,
    content,
    slateData,
  }: {
    categoryId?: string;
    spaceId?: string;
    title?: string;
    addMomentTag?: boolean;
    content?: string; // 这里仍然接收 markdown 文本
    slateData?: any; // 如果外部已经算好 Slate，可以直接传进来
  } = {},
  { dispatch, getState }: { dispatch: AppDispatch; getState: () => RootState }
): Promise<string> => {
  const state = getState();
  const userId = selectIdentityUserId(state);
  if (!userId) throw new Error("User ID not found.");

  // Important:
  // View-mode-based "create into current space vs no space" is decided by the UI entry
  // that triggers creation (currently the sidebar-top create button).
  // This action must preserve explicit caller intent:
  // - if `spaceId` is provided, use it;
  // - otherwise only fall back to the current selected space.
  const spaceId = customSpaceId ?? selectCurrentSpaceId(state);
  const { dbKey, id } = createPageKey.create(userId);

  const now = new Date();
  // Untitled by default — created time is shown as secondary meta in the page
  // chrome, not baked into the title (users should type a real name).
  const defaultTitle = i18n.t("page:untitled", {
    defaultValue: "未命名页面",
  });
  let title = asOptionalTrimmedString(initialTitle) ?? defaultTitle;

  const tags = addMomentTag ? ["moment"] : undefined;
  let pageMeta: PageData["meta"] | undefined;

  // ====== 根据 slateData / content 决定真正写入的 Slate 结构 ======
  let initialSlateData: EditorContent;

  if (slateData) {
    // 1. 如果外部已经传了 Slate，直接使用（兼容旧调用）
    initialSlateData = slateData as EditorContent;
  } else if (content) {
    const parsedProtocol = parseSkillDocProtocol(content);
    const normalizedContent = parsedProtocol.content;
    pageMeta = parsedProtocol.meta;
    console.log("content", content);
    // 2. 如果有 markdown content，优先尝试用 markdownToSlate 转成结构化 Slate
    try {
      const parsed = markdownToSlate(normalizedContent);
      console.log("parsed", parsed);

      if (Array.isArray(parsed) && parsed.length > 0) {
        const split = splitSlateTitleAndBody(parsed, initialTitle);
        title =
          asOptionalTrimmedString(initialTitle) ??
          (split.title || defaultTitle);
        initialSlateData = split.body;
      } else {
        // 解析结果为空时，退回到简单的纯文本段落
        initialSlateData = [
          { type: "paragraph", children: [{ text: normalizedContent }] },
        ];
      }
    } catch (e) {
      // 解析失败兜底：仍然保留原始文本，但当成普通段落
      console.error(
        "[createPageAction] markdownToSlate failed, fallback to plain text:",
        e
      );
      initialSlateData = [
        { type: "paragraph", children: [{ text: normalizedContent }] },
      ];
    }
  } else {
    // 3. 完全没有内容，创建一个空白页面
    initialSlateData = [createEmptyParagraph()];
  }
  // ====== 关键改动结束 ======

  // 关键防御：对传入的 categoryId 做归一化 / 过滤
  const safeCategoryId = normalizeCategoryId(categoryId);

  const pageData: PageData = {
    dbKey,
    id,
    type: DataType.DOC,
    title,
    spaceId,
    slateData: initialSlateData,
    // `content` 只作为只读展示缓存 / legacy bridge，真源仍是 `slateData`。
    content:
      typeof content === "string"
        ? parseSkillDocProtocol(content, pageMeta).content ||
          slateToRenderMarkdown(initialSlateData)
        : slateToRenderMarkdown(initialSlateData),
    tags,
    created: now.toISOString(),
    ...(pageMeta ? { meta: pageMeta } : {}),
  };

  const skillSummary = buildSkillSummaryMarker(pageMeta);

  await dispatch(write({ data: pageData, customKey: dbKey })).unwrap();

  if (spaceId) {
    (dispatch as any)(
      (addContentToSpace as any)({
          contentKey: dbKey,
          type: DataType.DOC,
          spaceId,
          title,
          // 只使用经过 normalize 的 safeCategoryId
          categoryId: safeCategoryId,
          ...(skillSummary ? { skillSummary } : {}),
        })
      );
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("nolo-user-data-updated"));
  }

  return dbKey;
};
