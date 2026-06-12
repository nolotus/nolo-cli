/**
 * ziweiChartTool — 紫微斗数排盘工具
 *
 * 改进点：
 * 1. displayData 从4行扩展为完整的十二宫全信息文本（所有星曜、大限、小限）
 * 2. gridText：ASCII 四行四列宫位排布，一眼看清空间关系
 * 3. analysisContext：AI 解盘所需的关键结构化数据
 *    - 四化落宫、空宫列表、重要星曜位置
 * 4. 星曜亮度符号（旺▲ 庙○ 陷▼ 平— 利+ 闲·）标注
 * 5. 四化标记（禄权科忌）直接嵌入星名
 */

import { astro } from "iztro";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ZiweiCalendarType = "solar" | "lunar";
export type ZiweiGender = "男" | "女" | "male" | "female";
export type ZiweiLanguage =
  | "zh-CN"
  | "zh-TW"
  | "en-US"
  | "ja-JP"
  | "ko-KR"
  | "vi-VN";

export interface ZiweiChartToolArgs {
  dateStr: string;
  timeIndex: number;
  gender: ZiweiGender;
  calendarType?: ZiweiCalendarType;
  isLeapMonth?: boolean;
  fixLeap?: boolean;
  language?: ZiweiLanguage;
}

interface StarSummary {
  name: string;
  brightness?: string;
  mutagen?: string;
  type: string;
}

interface NamedStarSummary {
  name: string;
  mutagen?: string;
}

interface PalaceSummary {
  index: number;
  name: string;
  heavenlyStem: string;
  earthlyBranch: string;
  isBodyPalace: boolean;
  isOriginalPalace: boolean;
  majorStars: StarSummary[];
  minorStars: string[];
  adjectiveStars: string[];
  changsheng12: string;
  boshi12: string;
  jiangqian12: string;
  suiqian12: string;
  decadal: {
    range: [number, number];
    heavenlyStem: string;
    earthlyBranch: string;
  };
  ages: number[];
}

interface FourTransformations {
  huaLu?: { star: string; palace: string };
  huaQuan?: { star: string; palace: string };
  huaKe?: { star: string; palace: string };
  huaJi?: { star: string; palace: string };
}

interface AnalysisContext {
  /** 命宫详情 */
  mingPalace: {
    name: string;
    earthlyBranch: string;
    heavenlyStem: string;
    majorStars: StarSummary[];
    minorStars: string[];
    decadalRange: [number, number];
  };
  /** 身宫详情 */
  bodyPalace: {
    name: string;
    earthlyBranch: string;
    majorStars: StarSummary[];
  };
  /** 生年四化落宫 */
  fourTransformations: FourTransformations;
  /** 空宫（无主星）宫位列表 */
  emptyPalaces: string[];
  /** 主星所在宫位索引 starName → palaceName */
  majorStarLocations: Record<string, string>;
  /** 大限当前建议：按年龄找当前大限宫 */
  decadalPalaces: Array<{
    palaceName: string;
    earthlyBranch: string;
    range: [number, number];
    majorStars: string[];
  }>;
}

export interface ZiweiChartToolResult {
  success: true;
  input: {
    calendarType: ZiweiCalendarType;
    dateStr: string;
    timeIndex: number;
    gender: string;
    isLeapMonth: boolean;
    fixLeap: boolean;
    language: ZiweiLanguage;
  };
  chart: {
    solarDate: string;
    lunarDate: string;
    chineseDate: string;
    heavenlyStemOfYear: string;
    time: string;
    timeRange: string;
    sign: string;
    zodiac: string;
    earthlyBranchOfSoulPalace: string;
    earthlyBranchOfBodyPalace: string;
    soul: string;
    body: string;
    fiveElementsClass: string;
    mutagenByYear: NamedStarSummary[];
    palaces: PalaceSummary[];
  };
  summary: {
    palaceCount: number;
    mingGong: string;
    shenGong: string;
    mingZhu: string;
    shenZhu: string;
    fiveElementsClass: string;
  };
  summaryText: string;
  /** 完整宫位信息文本（所有12宫全量展开，适合AI逐宫分析） */
  displayData: string;
  /** 四行四列 ASCII 宫位排布图 */
  gridText: string;
  /** AI 解盘关键结构化数据 */
  analysisContext: AnalysisContext;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIME_LABELS = [
  "早子时(00:00~01:00)",
  "丑时(01:00~03:00)",
  "寅时(03:00~05:00)",
  "卯时(05:00~07:00)",
  "辰时(07:00~09:00)",
  "巳时(09:00~11:00)",
  "午时(11:00~13:00)",
  "未时(13:00~15:00)",
  "申时(15:00~17:00)",
  "酉时(17:00~19:00)",
  "戌时(19:00~21:00)",
  "亥时(21:00~23:00)",
  "晚子时(23:00~24:00)",
] as const;

/**
 * 地支顺序 → 宫位网格位置映射
 * 传统紫微斗数盘面：
 *   巳 午 未 申   (top row, left→right)
 *   辰          酉   (second row, outer only)
 *   卯          戌   (third row, outer only)
 *   寅 丑 子 亥  (bottom row, left→right)
 */
const BRANCH_TO_GRID: Record<string, [number, number]> = {
  巳: [0, 0],
  午: [0, 1],
  未: [0, 2],
  申: [0, 3],
  酉: [1, 3],
  戌: [2, 3],
  亥: [3, 3],
  子: [3, 2],
  丑: [3, 1],
  寅: [3, 0],
  卯: [2, 0],
  辰: [1, 0],
};

const BRIGHTNESS_SYMBOL: Record<string, string> = {
  旺: "旺▲",
  庙: "庙○",
  陷: "陷▼",
  平: "平—",
  利: "利+",
  闲: "闲·",
  得: "得✦",
  不: "不✧",
};

const MUTAGEN_SYMBOL: Record<string, string> = {
  禄: "化禄",
  权: "化权",
  科: "化科",
  忌: "化忌",
};

const PALACE_ALIAS: Record<string, string> = {
  仆役: "交友",
  官禄: "事业",
};

// ─── Normalization helpers ───────────────────────────────────────────────────

function normalizeGender(input: string): ZiweiGender {
  const value = input.trim().toLowerCase();
  if (value === "男" || value === "male") return value as ZiweiGender;
  if (value === "女" || value === "female") return value as ZiweiGender;
  throw new Error('gender 只支持 "男"、"女"、"male"、"female"。');
}

function normalizeCalendarType(input: unknown): ZiweiCalendarType {
  return input === "lunar" ? "lunar" : "solar";
}

function normalizeLanguage(input: unknown): ZiweiLanguage {
  const value = typeof input === "string" ? input : "zh-CN";
  const supported = new Set<ZiweiLanguage>([
    "zh-CN",
    "zh-TW",
    "en-US",
    "ja-JP",
    "ko-KR",
    "vi-VN",
  ]);
  if (!supported.has(value as ZiweiLanguage)) {
    throw new Error(
      'language 只支持 "zh-CN"、"zh-TW"、"en-US"、"ja-JP"、"ko-KR"、"vi-VN"。'
    );
  }
  return value as ZiweiLanguage;
}

function normalizeTimeIndex(input: unknown): number {
  const value = typeof input === "number" ? Math.trunc(input) : Number(input);
  if (!Number.isInteger(value) || value < 0 || value > 12) {
    throw new Error("timeIndex 必须是 0 到 12 的整数。");
  }
  return value;
}

function normalizeDateStr(input: unknown): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
    throw new Error('dateStr 必须是 "YYYY-M-D" 或 "YYYY-MM-DD" 格式。');
  }
  return value;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatStarWithSymbols(star: StarSummary): string {
  const brightStr = star.brightness
    ? (BRIGHTNESS_SYMBOL[star.brightness] ?? star.brightness)
    : "";
  const mutagenStr = star.mutagen
    ? (MUTAGEN_SYMBOL[star.mutagen] ?? `化${star.mutagen}`)
    : "";
  const tags = [brightStr, mutagenStr].filter(Boolean);
  return tags.length > 0 ? `${star.name}[${tags.join(" ")}]` : star.name;
}

function dedupeMutagens(stars: StarSummary[]): NamedStarSummary[] {
  const seen = new Set<string>();
  return stars
    .filter((s) => !!s.mutagen)
    .map((s) => ({ name: s.name, mutagen: s.mutagen }))
    .filter((s) => {
      const key = `${s.mutagen}:${s.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ─── Display data builder (full 12-palace breakdown) ─────────────────────────

function buildFullDisplayData(
  palaces: PalaceSummary[],
  chart: ZiweiChartToolResult["chart"],
  input: ZiweiChartToolResult["input"]
): string {
  const divider = "─".repeat(60);
  const header = [
    `◆ 紫微斗数命盘 ◆`,
    `阳历：${chart.solarDate}　农历：${chart.lunarDate}`,
    `干支：${chart.chineseDate}`,
    `五行局：${chart.fiveElementsClass}　命主：${chart.soul}　身主：${chart.body}`,
    `生年四化：${
      chart.mutagenByYear.length > 0
        ? chart.mutagenByYear
            .map((m) => `${m.name}${MUTAGEN_SYMBOL[m.mutagen ?? ""] ?? `化${m.mutagen}`}`)
            .join("、")
        : "无"
    }`,
    `性别：${input.gender}　时辰：${TIME_LABELS[input.timeIndex] ?? input.timeIndex}`,
  ].join("\n");

  const palaceLines = palaces.map((p) => {
    const flags: string[] = [];
    if (p.isBodyPalace) flags.push("身宫");
    if (p.isOriginalPalace) flags.push("来因宫");
    const flagStr = flags.length > 0 ? ` [${flags.join(" ")}]` : "";

    const majorStr =
      p.majorStars.length > 0
        ? p.majorStars.map(formatStarWithSymbols).join("　")
        : "（空宫）";
    const minorStr = p.minorStars.length > 0 ? p.minorStars.join("、") : "无";
    const adjStr =
      p.adjectiveStars.length > 0 ? p.adjectiveStars.join("、") : "无";

    const displayPalaceName = PALACE_ALIAS[p.name] ?? p.name;
    const palateName = displayPalaceName.endsWith("宫")
      ? displayPalaceName
      : `${displayPalaceName}宫`;
    return [
      `【${p.heavenlyStem}${p.earthlyBranch}　${palateName}${flagStr}】`,
      `  主星：${majorStr}`,
      `  辅星：${minorStr}`,
      `  杂耀：${adjStr}`,
      `  长生十二神：${p.changsheng12}　博士十二神：${p.boshi12}`,
      `  将前十二神：${p.jiangqian12}　岁前十二神：${p.suiqian12}`,
      `  大限：${p.decadal.range[0]}-${p.decadal.range[1]}岁（${p.decadal.heavenlyStem}${p.decadal.earthlyBranch}）`,
      `  小限：${p.ages.join(" ")}`,
    ].join("\n");
  });

  return [header, divider, ...palaceLines].join("\n" + divider + "\n");
}

// ─── Grid text builder ───────────────────────────────────────────────────────

/**
 * 生成 ASCII 四行四列宫位图，中央2×2格显示基本信息。
 * 每格宽约 20 字符，展示：地支+宫名、主星、大限范围。
 */
function buildGridText(
  palaces: PalaceSummary[],
  chart: ZiweiChartToolResult["chart"]
): string {
  const branchToPalace: Record<string, PalaceSummary> = {};
  for (const p of palaces) {
    branchToPalace[p.earthlyBranch] = p;
  }

  const CELL_W = 22;
  const pad = (s: string) => s.slice(0, CELL_W).padEnd(CELL_W);

  function cellLines(branch: string): string[] {
    const p = branchToPalace[branch];
    if (!p) return ["", "", "", ""];
    const displayPalaceName = PALACE_ALIAS[p.name] ?? p.name;
    const flags = [p.isBodyPalace ? "身" : "", p.isOriginalPalace ? "来" : ""]
      .filter(Boolean)
      .join("");
    const flagStr = flags ? `[${flags}]` : "";
    const line1 = `${p.heavenlyStem}${branch} ${displayPalaceName}宫${flagStr}`;
    const majorNames =
      p.majorStars.length > 0
        ? p.majorStars.map((s) => {
            const b = s.brightness ? (BRIGHTNESS_SYMBOL[s.brightness]?.slice(0, 1) ?? "") : "";
            const m = s.mutagen ? `化${s.mutagen}` : "";
            return `${s.name}${b}${m}`;
          })
        : ["空宫"];
    const line2 = majorNames.join(" ");
    const line3 = `大限${p.decadal.range[0]}-${p.decadal.range[1]}`;
    const line4 = `小限 ${p.ages.slice(0, 4).join(" ")}`;
    return [line1, line2, line3, line4];
  }

  const centerInfo = [
    `阳历 ${chart.solarDate}`,
    `农历 ${chart.lunarDate}`,
    `${chart.fiveElementsClass}`,
    `命主:${chart.soul} 身主:${chart.body}`,
    `四化:${chart.mutagenByYear
      .map((m) => `${m.name}化${m.mutagen}`)
      .join(" ")}`,
    ``,
  ].map((s) => s.slice(0, CELL_W * 2).padEnd(CELL_W * 2));

  const branchRows: [string, string, string, string][] = [
    ["巳", "午", "未", "申"],
    ["辰", "", "", "酉"],
    ["卯", "", "", "戌"],
    ["寅", "丑", "子", "亥"],
  ];

  const sep = "+" + (["-".repeat(CELL_W), "-".repeat(CELL_W), "-".repeat(CELL_W), "-".repeat(CELL_W)].join("+")) + "+";

  const lines: string[] = [sep];

  for (let row = 0; row < 4; row++) {
    const rowBranches = branchRows[row];
    // build 4 cell content (4 lines each)
    const cellData: string[][] = rowBranches.map((b) =>
      b ? cellLines(b) : ["", "", "", ""]
    );

    for (let lineIdx = 0; lineIdx < 4; lineIdx++) {
      // rows 1-2, cols 1-2 are center
      const parts: string[] = [];
      for (let col = 0; col < 4; col++) {
        const isCenter = (row === 1 || row === 2) && (col === 1 || col === 2);
        if (isCenter) {
          // center cells: span handled separately, skip col 2 merging
          if (col === 1) {
            // render merged center 2-col wide cell
            const centerLineIdx = (row - 1) * 4 + lineIdx;
            parts.push(centerInfo[centerLineIdx] ?? " ".repeat(CELL_W * 2));
          }
          // col 2 is absorbed into the merged center; skip rendering a separator
        } else {
          parts.push(pad(cellData[col][lineIdx] ?? ""));
        }
      }
      // build line: |col0|center(merged)|col3|
      if ((row === 1 || row === 2)) {
        lines.push(`|${pad(cellData[0][lineIdx])}|${centerInfo[(row - 1) * 4 + lineIdx] ?? " ".repeat(CELL_W * 2)}|${pad(cellData[3][lineIdx])}|`);
      } else {
        lines.push(`|${cellData.map((c) => pad(c[lineIdx] ?? "")).join("|")}|`);
      }
    }
    lines.push(sep);
  }

  return lines.join("\n");
}

// ─── Analysis context builder ─────────────────────────────────────────────────

function buildAnalysisContext(
  palaces: PalaceSummary[],
  chart: ZiweiChartToolResult["chart"]
): AnalysisContext {
  const byBranch = new Map<string, PalaceSummary>();
  for (const p of palaces) byBranch.set(p.earthlyBranch, p);

  const mingPalaceData =
    byBranch.get(chart.earthlyBranchOfSoulPalace) ??
    palaces.find((p) => p.name === "命宫")!;
  const bodyPalaceData =
    byBranch.get(chart.earthlyBranchOfBodyPalace) ??
    palaces.find((p) => p.isBodyPalace)!;

  // 四化落宫
  const fourTransformations: FourTransformations = {};
  for (const p of palaces) {
    for (const s of p.majorStars) {
      if (!s.mutagen) continue;
      const entry = { star: s.name, palace: `${p.name}宫` };
      if (s.mutagen === "禄") fourTransformations.huaLu = entry;
      else if (s.mutagen === "权") fourTransformations.huaQuan = entry;
      else if (s.mutagen === "科") fourTransformations.huaKe = entry;
      else if (s.mutagen === "忌") fourTransformations.huaJi = entry;
    }
  }

  // 空宫
  const emptyPalaces = palaces
    .filter((p) => p.majorStars.length === 0)
    .map((p) => `${p.name}宫（${p.heavenlyStem}${p.earthlyBranch}）`);

  // 主星位置
  const majorStarLocations: Record<string, string> = {};
  for (const p of palaces) {
    for (const s of p.majorStars) {
      majorStarLocations[s.name] = `${p.name}宫`;
    }
  }

  // 大限宫列表（按年龄排序）
  const decadalPalaces = [...palaces]
    .sort((a, b) => a.decadal.range[0] - b.decadal.range[0])
    .map((p) => ({
      palaceName: p.name,
      earthlyBranch: p.earthlyBranch,
      range: p.decadal.range,
      majorStars: p.majorStars.map((s) => s.name),
    }));

  return {
    mingPalace: {
      name: mingPalaceData?.name ?? "",
      earthlyBranch: chart.earthlyBranchOfSoulPalace,
      heavenlyStem: mingPalaceData?.heavenlyStem ?? "",
      majorStars: mingPalaceData?.majorStars ?? [],
      minorStars: mingPalaceData?.minorStars ?? [],
      decadalRange: mingPalaceData?.decadal.range ?? [0, 0],
    },
    bodyPalace: {
      name: bodyPalaceData?.name ?? "",
      earthlyBranch: chart.earthlyBranchOfBodyPalace,
      majorStars: bodyPalaceData?.majorStars ?? [],
    },
    fourTransformations,
    emptyPalaces,
    majorStarLocations,
    decadalPalaces,
  };
}

// ─── Main function ────────────────────────────────────────────────────────────

export function runZiweiChart(input: ZiweiChartToolArgs): ZiweiChartToolResult {
  const calendarType = normalizeCalendarType(input.calendarType);
  const language = normalizeLanguage(input.language);
  const dateStr = normalizeDateStr(input.dateStr);
  const timeIndex = normalizeTimeIndex(input.timeIndex);
  const gender = normalizeGender(input.gender);
  const fixLeap = input.fixLeap !== false;
  const isLeapMonth = input.isLeapMonth === true;

  const rawChart =
    calendarType === "lunar"
      ? astro.byLunar(dateStr, timeIndex, gender, isLeapMonth, fixLeap, language)
      : astro.bySolar(dateStr, timeIndex, gender, fixLeap, language);

  const palaces: PalaceSummary[] = rawChart.palaces.map((palace) => ({
    index: palace.index,
    name: palace.name,
    heavenlyStem: palace.heavenlyStem,
    earthlyBranch: palace.earthlyBranch,
    isBodyPalace: palace.isBodyPalace,
    isOriginalPalace: palace.isOriginalPalace,
    majorStars: palace.majorStars.map((star) => ({
      name: star.name,
      brightness: star.brightness || undefined,
      mutagen: star.mutagen || undefined,
      type: star.type,
    })),
    minorStars: palace.minorStars.map((star) => star.name),
    adjectiveStars: palace.adjectiveStars.map((star) => star.name),
    changsheng12: palace.changsheng12,
    boshi12: palace.boshi12,
    jiangqian12: palace.jiangqian12,
    suiqian12: palace.suiqian12,
    decadal: palace.decadal,
    ages: palace.ages,
  }));

  const mutagenByYear = dedupeMutagens(palaces.flatMap((p) => p.majorStars));
  const mingGong = `${rawChart.earthlyBranchOfSoulPalace}宫`;
  const shenGong = `${rawChart.earthlyBranchOfBodyPalace}宫`;
  const heavenlyStemOfYear =
    rawChart.chineseDate.split(" ")[0]?.slice(0, 1) ?? "";

  const chartData: ZiweiChartToolResult["chart"] = {
    solarDate: rawChart.solarDate,
    lunarDate: rawChart.lunarDate,
    chineseDate: rawChart.chineseDate,
    heavenlyStemOfYear,
    time: rawChart.time,
    timeRange: rawChart.timeRange,
    sign: rawChart.sign,
    zodiac: rawChart.zodiac,
    earthlyBranchOfSoulPalace: rawChart.earthlyBranchOfSoulPalace,
    earthlyBranchOfBodyPalace: rawChart.earthlyBranchOfBodyPalace,
    soul: rawChart.soul,
    body: rawChart.body,
    fiveElementsClass: rawChart.fiveElementsClass,
    mutagenByYear,
    palaces,
  };

  const inputNorm: ZiweiChartToolResult["input"] = {
    calendarType,
    dateStr,
    timeIndex,
    gender,
    isLeapMonth,
    fixLeap,
    language,
  };

  const displayData = buildFullDisplayData(palaces, chartData, inputNorm);
  const gridText = buildGridText(palaces, chartData);
  const analysisContext = buildAnalysisContext(palaces, chartData);
  const summaryText = `命宫 ${mingGong}｜身宫 ${shenGong}｜命主 ${rawChart.soul}｜身主 ${rawChart.body}｜五行局 ${rawChart.fiveElementsClass}`;

  return {
    success: true,
    input: inputNorm,
    chart: chartData,
    summary: {
      palaceCount: palaces.length,
      mingGong,
      shenGong,
      mingZhu: rawChart.soul,
        shenZhu: rawChart.body,
        fiveElementsClass: rawChart.fiveElementsClass,
      },
    summaryText,
    displayData,
    gridText,
    analysisContext,
  };
}

// ─── Function schema ──────────────────────────────────────────────────────────

export const ziweiChartFunctionSchema = {
  name: "ziweiChart",
  description: [
    "根据出生日期、时辰和性别生成紫微斗数完整排盘。",
    "输出包含：",
    "  1. chart：结构化十二宫完整数据（主星亮度/四化/大限/小限）",
    "  2. displayData：十二宫全展开文本，每宫含主星/辅星/杂耀/长生/博士/将前/岁前",
    "  3. gridText：ASCII 四行四列宫位排布图，直观显示空间关系",
    "  4. analysisContext：AI 解盘关键数据（四化落宫、空宫、主星位置、大限序列）",
    "timeIndex 0~12：0=早子，1=丑，2=寅，3=卯，4=辰，5=巳，6=午，7=未，8=申，9=酉，10=戌，11=亥，12=晚子。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      dateStr: {
        type: "string",
        description: '出生日期，"YYYY-M-D" 或 "YYYY-MM-DD"。例如 "1983-11-7"。',
      },
      timeIndex: {
        type: "number",
        description:
          "出生时辰序号 0~12。0=早子，1=丑，2=寅，3=卯，4=辰，5=巳，6=午，7=未，8=申，9=酉，10=戌，11=亥，12=晚子。",
      },
      gender: {
        type: "string",
        description: '性别："男"、"女"、"male"、"female"。',
      },
      calendarType: {
        type: "string",
        enum: ["solar", "lunar"],
        description: '日期类型，默认 "solar"（阳历）。"lunar" 为农历。',
      },
      isLeapMonth: {
        type: "boolean",
        description: '农历闰月时设为 true，默认 false。',
      },
      fixLeap: {
        type: "boolean",
        description: "闰月修正，默认 true。",
      },
      language: {
        type: "string",
        enum: ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "vi-VN"],
        description: '输出语言，默认 "zh-CN"。',
      },
    },
    required: ["dateStr", "timeIndex", "gender"],
  },
} as const;

export async function ziweiChartFunc(
  args: ZiweiChartToolArgs
): Promise<{ rawData: ZiweiChartToolResult; displayData: string; gridText: string }> {
  const result = runZiweiChart(args);
  return {
    rawData: result,
    displayData: result.displayData,
    gridText: result.gridText,
  };
}
