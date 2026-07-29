import { compactWhitespace } from "../../core/compactWhitespace";
import { asTrimmedString } from "../../core/trimmedString";

type AppSourceFile = { name: string; code: string };

type AppSourceSnapshot = {
  code?: string | null;
  files?: Array<{ name?: string | null; code?: string | null }> | null;
};

const TOKEN_FILE_PATTERN = /(tokens|theme|design-?system)\.(t|j)sx?$/i;
const SMALL_VISUAL_RE =
  /(font|typography|text size|text bigger|font size|color|spacing|padding|margin|radius|shadow|line-height|letter-spacing|字号|字体|字重|颜色|配色|圆角|阴影|间距|留白)/i;
const BROAD_CHANGE_RE =
  /(redesign|rewrite|refactor|new page|new feature|layout overhaul|full rebuild|重做|改版|重构|新页面|新功能|整体改|整个页面)/i;
const LOGIC_MARKERS = [
  "useEffect(",
  "useState(",
  "fetch(",
  "axios.",
  "dispatch(",
  "navigate(",
  "createBrowserRouter(",
  "addEventListener(",
  "removeEventListener(",
  "setInterval(",
  "setTimeout(",
];

export type SmallVisualEditGuardResult =
  | {
      ok: true;
      reason: "not-applicable";
    }
  | {
      ok: false;
      summary: string;
      displayData: string;
      rawData: {
        success: false;
        ok: false;
        error: true;
        code: "SMALL_VISUAL_SCOPE_EXCEEDED";
        summary: string;
        requestType: "small-visual-edit";
        issueCodes: string[];
        evidence: string[];
        retryable: true;
        repairPlan: {
          strategy: "targeted-repair";
          scope: "existing-files";
          mode: "preflight-first";
          summary: string;
          steps: Array<{ action: string; reason: string }>;
          issueCodes: string[];
          suggestedFiles: string[];
          keepFiles?: string[];
          revertFiles?: string[];
          preferTokenFiles?: string[];
          targetStyleFields?: string[];
          targetElements?: string[];
          rerun: ["appPreflight", "appDeploy"];
        };
      };
    };

const toNormalizedFiles = (input: AppSourceSnapshot): AppSourceFile[] => {
  const files = Array.isArray(input.files)
    ? input.files
        .filter(
          (file): file is { name: string; code: string } =>
            !!file &&
            typeof file.name === "string" &&
            typeof file.code === "string"
        )
        .map((file) => ({ name: file.name, code: file.code }))
    : [];
  if (files.length > 0) return files;

  const code = typeof input.code === "string" ? input.code : "";
  if (!code.trim()) return [];
  return [{ name: "worker.ts", code }];
};

const buildFileMap = (files: AppSourceFile[]) =>
  new Map(files.map((file) => [file.name, file.code]));

const extractJsxTagCounts = (code: string): Map<string, number> => {
  const counts = new Map<string, number>();
  const matches = code.matchAll(/<([A-Za-z][\w.-]*)\b/g);
  for (const match of matches) {
    const tag = match[1];
    if (!tag) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
};

const hasLargeStructureChange = (previousCode: string, nextCode: string): boolean => {
  const previousTags = extractJsxTagCounts(previousCode);
  const nextTags = extractJsxTagCounts(nextCode);
  if (previousTags.size === 0 && nextTags.size === 0) return false;

  const tagNames = new Set([...previousTags.keys(), ...nextTags.keys()]);
  let totalDelta = 0;
  let changedKinds = 0;
  for (const tag of tagNames) {
    const delta = Math.abs((previousTags.get(tag) ?? 0) - (nextTags.get(tag) ?? 0));
    if (delta > 0) changedKinds += 1;
    totalDelta += delta;
  }

  const previousLines = previousCode.split("\n").length;
  const nextLines = nextCode.split("\n").length;
  const lineDelta = Math.abs(previousLines - nextLines);

  return totalDelta > 4 || changedKinds > 3 || lineDelta > Math.max(25, Math.round(previousLines * 0.35));
};

const hasLogicMarkerChange = (previousCode: string, nextCode: string): boolean =>
  LOGIC_MARKERS.some((marker) => previousCode.includes(marker) !== nextCode.includes(marker));

const STYLE_FIELDS = [
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "padding",
  "margin",
  "gap",
  "borderRadius",
  "boxShadow",
] as const;

const FIELD_TRIGGER_MAP: Array<{ field: string; re: RegExp }> = [
  { field: "fontSize", re: /(font|text size|font size|字号|字体|字大|字小)/i },
  { field: "fontWeight", re: /(font weight|字重|加粗|粗一点)/i },
  { field: "lineHeight", re: /(line-height|line height|行高)/i },
  { field: "letterSpacing", re: /(letter-spacing|letter spacing|字距)/i },
  { field: "color", re: /(color|颜色|配色)/i },
  { field: "backgroundColor", re: /(background|背景|底色)/i },
  { field: "padding", re: /(padding|内边距)/i },
  { field: "margin", re: /(margin|外边距|留白|间距)/i },
  { field: "gap", re: /(gap|间距)/i },
  { field: "borderRadius", re: /(radius|圆角)/i },
  { field: "boxShadow", re: /(shadow|阴影)/i },
];

const extractStyleFields = (code: string): string[] => {
  const found = new Set<string>();
  for (const field of STYLE_FIELDS) {
    if (code.includes(`${field}:`)) found.add(field);
  }
  return [...found];
};

const ELEMENT_TRIGGER_MAP: Array<{ element: string; re: RegExp; aliases: string[] }> = [
  { element: "button", re: /(button|按钮)/i, aliases: ["button"] },
  { element: "body-text", re: /(正文|body text|paragraph|段落)/i, aliases: ["p"] },
  { element: "title", re: /(title|headline|标题)/i, aliases: ["h1", "h2", "h3"] },
  {
    element: "container",
    re: /(card|container|panel|section|卡片|容器|面板)/i,
    aliases: ["section", "main", "div", "article"],
  },
];

const inferRequestedElements = (userInput: string | null | undefined): string[] => {
  const text = typeof userInput === "string" ? userInput : "";
  const found = new Set<string>();
  for (const rule of ELEMENT_TRIGGER_MAP) {
    if (!rule.re.test(text)) continue;
    for (const alias of rule.aliases) found.add(alias);
  }
  return [...found];
};

const extractStyledTagSignatures = (code: string): Map<string, string[]> => {
  const result = new Map<string, string[]>();
  const matches = code.matchAll(/<([A-Za-z][\w.-]*)\b[^>]*style=\{\{([\s\S]*?)\}\}[^>]*>/g);
  for (const match of matches) {
    const tag = match[1];
    const style = match[2];
    if (!tag || !style) continue;
    const list = result.get(tag) ?? [];
    list.push(compactWhitespace(style));
    result.set(tag, list);
  }
  return result;
};

const inferRequestedStyleFields = (userInput: string | null | undefined): string[] => {
  const text = typeof userInput === "string" ? userInput : "";
  const found = new Set<string>();
  for (const rule of FIELD_TRIGGER_MAP) {
    if (rule.re.test(text)) found.add(rule.field);
  }
  return [...found];
};

export const isSmallVisualEditRequest = (input: string | null | undefined): boolean => {
  const text = asTrimmedString(input);
  if (!text) return false;
  return SMALL_VISUAL_RE.test(text) && !BROAD_CHANGE_RE.test(text);
};

export const evaluateSmallVisualEditGuard = (params: {
  userInput?: string | null;
  previousSource: AppSourceSnapshot;
  nextSource: AppSourceSnapshot;
}): SmallVisualEditGuardResult => {
  if (!isSmallVisualEditRequest(params.userInput)) {
    return { ok: true, reason: "not-applicable" };
  }

  const previousFiles = toNormalizedFiles(params.previousSource);
  const nextFiles = toNormalizedFiles(params.nextSource);
  if (previousFiles.length === 0 || nextFiles.length === 0) {
    return { ok: true, reason: "not-applicable" };
  }

  const previousByName = buildFileMap(previousFiles);
  const nextByName = buildFileMap(nextFiles);
  const previousNames = new Set(previousByName.keys());
  const nextNames = new Set(nextByName.keys());

  const addedFiles = [...nextNames].filter((name) => !previousNames.has(name));
  const deletedFiles = [...previousNames].filter((name) => !nextNames.has(name));
  const changedFiles = [...nextNames].filter(
    (name) => previousByName.has(name) && previousByName.get(name) !== nextByName.get(name)
  );

  const evidence: string[] = [];
  const issueCodes: string[] = [];
  const tokenFiles = [...nextNames].filter((name) => TOKEN_FILE_PATTERN.test(name));
  const targetStyleFields = inferRequestedStyleFields(params.userInput);
  const targetElements = inferRequestedElements(params.userInput);

  if (deletedFiles.length > 0) {
    issueCodes.push("deleted-files");
    evidence.push(`删除了文件：${deletedFiles.join(", ")}`);
  }

  const nonTokenAddedFiles = addedFiles.filter((name) => !TOKEN_FILE_PATTERN.test(name));
  if (nonTokenAddedFiles.length > 0) {
    issueCodes.push("added-non-token-files");
    evidence.push(`新增了非 token 文件：${nonTokenAddedFiles.join(", ")}`);
  }

  if (changedFiles.length + addedFiles.length > 4) {
    issueCodes.push("too-many-files");
    evidence.push(
      `命中了过多文件：修改 ${changedFiles.length} 个，新增 ${addedFiles.length} 个`
    );
  }

  for (const fileName of changedFiles) {
    if (TOKEN_FILE_PATTERN.test(fileName)) continue;
    const previousCode = previousByName.get(fileName) ?? "";
    const nextCode = nextByName.get(fileName) ?? "";

    if (hasLogicMarkerChange(previousCode, nextCode)) {
      issueCodes.push("logic-change");
      evidence.push(`文件 ${fileName} 出现了逻辑层标记变化`);
    }

    if (hasLargeStructureChange(previousCode, nextCode)) {
      issueCodes.push("jsx-structure-change");
      evidence.push(`文件 ${fileName} 的 JSX 结构变化过大`);
    }

    if (targetElements.length > 0) {
      const previousTags = extractStyledTagSignatures(previousCode);
      const nextTags = extractStyledTagSignatures(nextCode);
      const tagNames = new Set([...previousTags.keys(), ...nextTags.keys()]);
      const unauthorizedTags = [...tagNames].filter((tag) => {
        const previousSignature = JSON.stringify(previousTags.get(tag) ?? []);
        const nextSignature = JSON.stringify(nextTags.get(tag) ?? []);
        if (previousSignature === nextSignature) return false;
        return !targetElements.includes(tag);
      });
      if (unauthorizedTags.length > 0) {
        issueCodes.push("non-target-element-change");
        evidence.push(
          `文件 ${fileName} 改到了未点名元素：${unauthorizedTags.join(", ")}`
        );
      }
    }
  }

  if (issueCodes.length === 0) {
    return { ok: true, reason: "not-applicable" };
  }

  const suggestedFiles = [...new Set([...changedFiles, ...addedFiles])];
  const revertFiles = [...new Set([...deletedFiles, ...nonTokenAddedFiles])];
  const keepFiles = [
    ...new Set([
      ...changedFiles.filter((name) => !revertFiles.includes(name)),
      ...tokenFiles,
    ]),
  ];
  const observedStyleFields = [
    ...new Set(
      changedFiles.flatMap((fileName) => extractStyleFields(nextByName.get(fileName) ?? ""))
    ),
  ];
  const scopedStyleFields = targetStyleFields.length > 0 ? targetStyleFields : observedStyleFields;
  const summary =
    "这次请求更像“小范围视觉微调”，但当前改动超出了安全范围，先不要直接部署。请收敛到 token / 命中的局部样式，再重新预检和部署。";
  const displayData = [
    "⚠️ 小视觉修改守卫已拦截本次部署。",
    summary,
    "",
    "超范围证据：",
    ...evidence.map((item) => `- ${item}`),
    "",
    "修复建议：",
    "- 保留字体 / 颜色 / 间距 / 圆角 / 阴影相关改动。",
    "- 不要新增非 token 文件，不要删除现有文件。",
    "- 不要改布局结构、组件树、事件逻辑、数据流或路由。",
    "- 如需统一样式，可新增一个最小 tokens/theme 文件，并只让命中的组件消费它。",
    ...(keepFiles.length > 0 ? [`- 优先保留文件：${keepFiles.join(", ")}`] : []),
    ...(revertFiles.length > 0 ? [`- 优先回退文件：${revertFiles.join(", ")}`] : []),
    ...(scopedStyleFields.length > 0
      ? [`- 这轮只允许继续调整这些视觉字段：${scopedStyleFields.join(", ")}`]
      : []),
    ...(targetElements.length > 0
      ? [`- 这轮只允许继续调整这些元素：${targetElements.join(", ")}`]
      : []),
  ].join("\n");

  return {
    ok: false,
    summary,
    displayData,
    rawData: {
      success: false,
      ok: false,
      error: true,
      code: "SMALL_VISUAL_SCOPE_EXCEEDED",
      summary,
      requestType: "small-visual-edit",
      issueCodes,
      evidence,
      retryable: true,
      repairPlan: {
        strategy: "targeted-repair",
        scope: "existing-files",
        mode: "preflight-first",
        summary,
        steps: [
          {
            action: "回退超出视觉范围的结构与逻辑修改",
            reason: "当前请求只要求小范围视觉微调，不应顺带重写页面结构或行为逻辑",
          },
          {
            action: "把视觉参数收敛到命中的局部组件或最小 token 层",
            reason: "这样可以保留局部改动并避免继续散落新的硬编码",
          },
        ],
        issueCodes,
        suggestedFiles,
        ...(keepFiles.length > 0 ? { keepFiles } : {}),
        ...(revertFiles.length > 0 ? { revertFiles } : {}),
        ...(tokenFiles.length > 0 ? { preferTokenFiles: tokenFiles } : {}),
        ...(scopedStyleFields.length > 0 ? { targetStyleFields: scopedStyleFields } : {}),
        ...(targetElements.length > 0 ? { targetElements } : {}),
        rerun: ["appPreflight", "appDeploy"],
      },
    },
  };
};
