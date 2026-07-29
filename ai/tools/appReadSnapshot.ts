import { asTrimmedString } from "../../core/trimmedString";

type AppReadSnapshotInput = {
  code?: string | null;
  files?: Array<{ name?: string | null; code?: string | null }> | null;
};

export type AppReadSnapshotKind =
  | "source-files"
  | "single-file-source"
  | "compiled-artifact";

export type AppStyleSystemStatus =
  | "design-system"
  | "hardcoded-inline-styles"
  | "unknown";

const COMPILED_ARTIFACT_PATTERNS = [
  "<!DOCTYPE html>",
  '<script type="importmap">',
  "react-dom/client",
  "createRoot(",
  "esm.sh/",
  "__toESM(",
];

export const classifyAppReadSnapshot = (
  input: AppReadSnapshotInput
): AppReadSnapshotKind => {
  const files = Array.isArray(input.files)
    ? input.files.filter(
        (file) =>
          !!file &&
          typeof file.name === "string" &&
          typeof file.code === "string" &&
          file.code.trim().length > 0
      )
    : [];

  if (files.length > 0) {
    return "source-files";
  }

  const code = asTrimmedString(input.code);
  if (!code) {
    return "single-file-source";
  }

  const looksCompiled = COMPILED_ARTIFACT_PATTERNS.some((pattern) =>
    code.includes(pattern)
  );

  return looksCompiled ? "compiled-artifact" : "single-file-source";
};

export const buildAppReadSnapshotWarning = (
  kind: AppReadSnapshotKind
): string | null => {
  if (kind !== "compiled-artifact") return null;

  return [
    "⚠️ 检测到当前读到的更像“部署产物 / 打包 bundle”，不是原始可维护源码文件。",
    "这类结果通常只适合理解现状，不适合在未告知用户的情况下做局部增量修改。",
    "如果用户只想改一小部分，必须先明确说明当前缺少原始源码快照；未经用户确认，不要直接整站重写后 appDeploy。",
  ].join("\n");
};

const STYLE_SYSTEM_FILE_PATTERN = /(tokens|theme|design-?system)\.(t|j)sx?$/i;
const STYLE_SYSTEM_EXPORT_PATTERN =
  /\b(?:export\s+const|const)\s+(tokens|theme|designSystem)\b/;
const INLINE_STYLE_PATTERN = /style=\{\{/g;
const HARD_CODED_STYLE_VALUE_PATTERN =
  /\b(fontSize|color|backgroundColor|padding|margin|gap|borderRadius|boxShadow|lineHeight)\s*:\s*['"`#0-9a-zA-Z.(]/g;

export const analyzeAppStyleSystem = (input: AppReadSnapshotInput): {
  status: AppStyleSystemStatus;
  legacyMigrationRecommended: boolean;
  evidence: string[];
} => {
  const files = Array.isArray(input.files)
    ? input.files.filter(
        (file): file is { name: string; code: string } =>
          !!file &&
          typeof file.name === "string" &&
          typeof file.code === "string"
      )
    : [];

  const combinedSource = (
    files.length > 0
      ? files.map((file) => `${file.name}\n${file.code}`).join("\n\n")
      : typeof input.code === "string"
        ? input.code
        : ""
  ).trim();

  const evidence: string[] = [];

  if (
    files.some((file) => STYLE_SYSTEM_FILE_PATTERN.test(file.name)) ||
    STYLE_SYSTEM_EXPORT_PATTERN.test(combinedSource)
  ) {
    if (files.some((file) => STYLE_SYSTEM_FILE_PATTERN.test(file.name))) {
      evidence.push("发现 tokens/theme/design-system 文件");
    }
    if (STYLE_SYSTEM_EXPORT_PATTERN.test(combinedSource)) {
      evidence.push("发现 tokens/theme/designSystem 导出");
    }
    return {
      status: "design-system",
      legacyMigrationRecommended: false,
      evidence,
    };
  }

  const inlineStyleMatches = combinedSource.match(INLINE_STYLE_PATTERN)?.length ?? 0;
  const hardcodedStyleMatches =
    combinedSource.match(HARD_CODED_STYLE_VALUE_PATTERN)?.length ?? 0;

  if (inlineStyleMatches >= 1 && hardcodedStyleMatches >= 4) {
    evidence.push(`检测到 ${inlineStyleMatches} 处内联 style`);
    evidence.push(`检测到 ${hardcodedStyleMatches} 处硬编码视觉值`);
    return {
      status: "hardcoded-inline-styles",
      legacyMigrationRecommended: true,
      evidence,
    };
  }

  return {
    status: "unknown",
    legacyMigrationRecommended: false,
    evidence,
  };
};

export const buildAppStyleSystemHint = (
  analysis: ReturnType<typeof analyzeAppStyleSystem>
): string | null => {
  if (analysis.status === "design-system") {
    return [
      "🧩 检测到当前应用已经有设计系统 / token 层。",
      "后续视觉微调应优先改这层共享 token，而不是把新数字继续散落回组件。",
    ].join("\n");
  }

  if (analysis.status === "hardcoded-inline-styles") {
    return [
      "🧩 检测到当前应用更像旧式硬编码样式：多个视觉值直接散落在组件内联 style 中。",
      "如果用户这次只是调字体、颜色、间距、圆角、阴影，默认建议先做一次最小 token 迁移（如新增 tokens.ts / theme 对象），再在 token 层完成修改。",
    ].join("\n");
  }

  return null;
};
