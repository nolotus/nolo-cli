import { afterEach, describe, expect, test } from "bun:test";
import { getCliLocale, initCliLocale, parseCliLocale, setCliLocale, t } from "./i18n";

describe("i18n", () => {
  const original = getCliLocale();
  afterEach(() => setCliLocale(original));

  test("returns English strings by default", () => {
    setCliLocale("en");
    expect(t("promptLabel")).toBe("❯ ");
    expect(t("bye")).toBe("Bye.");
    expect(t("newDialog")).toBe("new dialog");
    expect(t("placeholder")).toBe("Type a message or / for commands...");
  });

  test("returns Chinese strings when locale is zh", () => {
    setCliLocale("zh");
    expect(t("promptLabel")).toBe("❯ ");
    expect(t("bye")).toBe("再见。");
    expect(t("newDialog")).toBe("新对话");
    expect(t("placeholder")).toBe("输入消息，或用 / 查看命令…");
  });

  test("welcomeHint is localized", () => {
    setCliLocale("en");
    expect(t("welcomeHint")).toContain("Shift+Enter");
    setCliLocale("zh");
    expect(t("welcomeHint")).toContain("换行");
  });

  test("continueLabel is localized", () => {
    setCliLocale("en");
    expect(t("continueLabel")).toBe("│ ");
    setCliLocale("zh");
    expect(t("continueLabel")).toBe("│ ");
  });

  test("NOLO_LANG overrides shell locale detection", () => {
    initCliLocale({ NOLO_LANG: "en", LANG: "zh_CN.UTF-8" });
    expect(getCliLocale()).toBe("en");
    initCliLocale({ NOLO_LANG: "zh", LANG: "en_US.UTF-8" });
    expect(getCliLocale()).toBe("zh");
    initCliLocale({ LANG: "zh_CN.UTF-8" });
    expect(getCliLocale()).toBe("zh");
  });

  test("parseCliLocale accepts zh/en variants and rejects junk", () => {
    expect(parseCliLocale("zh")).toBe("zh");
    expect(parseCliLocale("zh_CN.UTF-8")).toBe("zh");
    expect(parseCliLocale("EN")).toBe("en");
    expect(parseCliLocale("fr")).toBeNull();
    expect(parseCliLocale(undefined)).toBeNull();
  });

  test("help text is fully translated in both locales", () => {
    setCliLocale("zh");
    expect(t("helpText")).toContain("/history");
    expect(t("helpText")).toContain("切换界面语言");
    setCliLocale("en");
    expect(t("helpText")).toContain("/lang <zh|en>");
  });

  test("ask choice chrome is localized", () => {
    setCliLocale("zh");
    expect(t("askChoiceTitle")).toBe("问题");
    expect(t("askChoiceOtherLabel")).toBe("其他");
    expect(t("askChoiceHistorySelected")).toBe("已选");
    expect(t("askChoiceHistoryCancelled")).toBe("已取消");
    setCliLocale("en");
    expect(t("askChoiceTitle")).toBe("question");
    expect(t("askChoiceOtherLabel")).toBe("Other");
    expect(t("askChoiceHistoryHint")).toContain("Type a number");
  });

  test("turnStoppedToolPending resolves to non-empty text in both locales", () => {
    setCliLocale("en");
    const en = t("turnStoppedToolPending", "editFile");
    expect(en.length).toBeGreaterThan(0);
    expect(en).toContain("editFile");
    setCliLocale("zh");
    const zh = t("turnStoppedToolPending", "editFile");
    expect(zh.length).toBeGreaterThan(0);
    expect(zh).toContain("editFile");
  });

  // Keys added by the i18n completion pass (Task B). Every one must resolve
  // to non-empty copy in both locales and the two must differ — identical
  // zh/en means the translation was never written.
  const NEW_KEYS = [
    "unknownCommand",
    "runtimeUsage",
    "runtimeSet",
    "toolsCurrent",
    "toolsUsage",
    "toolsSet",
    "thinkingCurrent",
    "thinkingUsage",
    "thinkingSet",
    "tasksRunning",
    "tasksStopped",
    "tasksNone",
    "stopUsage",
    "stopAllDone",
    "stopNoPid",
    "stopPidDone",
    "stopNoLabel",
    "stopLabelsDone",
    "compactNothing",
    "agentCurrent",
    "agentUnknown",
    "themeCurrent",
    "themeUsage",
    "themeAvailable",
    "themeBrightnessSwitched",
    "themeBrightnessAuto",
    "themeSwitched",
    "themeUnknown",
    "densityCurrent",
    "densitySwitched",
    "densityUnknown",
    "docAttachUsage",
    "docList",
    "docNone",
    "skillAttachUsage",
    "skillAttached",
    "skillDetachUsage",
    "skillDetached",
    "skillNotAttached",
    "skillNone",
    "skillCleared",
    "skillList",
    "skillNoneHint",
    "customizeHint",
    "loginHint",
    "versionInfo",
    "versionUnknown",
    "recentDialogs",
    "dialogListTip",
    "timeJustNow",
    "timeMinutesAgo",
    "timeHoursAgo",
    "timeDaysAgo",
    "dialogMoreAbove",
    "dialogMoreBelow",
  ] as const;

  test("every new key resolves to non-empty, distinct copy in both locales", () => {
    for (const key of NEW_KEYS) {
      setCliLocale("en");
      const en = t(key, "0", "1");
      setCliLocale("zh");
      const zh = t(key, "0", "1");
      expect(en.length, `en copy for ${key}`).toBeGreaterThan(0);
      expect(zh.length, `zh copy for ${key}`).toBeGreaterThan(0);
      expect(zh, `zh === en means ${key} was not translated`).not.toBe(en);
    }
  });

  test("interpolation placeholders are replaced in the new keys", () => {
    setCliLocale("en");
    expect(t("stopPidDone", "1001", "build")).toBe("Stopped pid 1001 (build)");
    expect(t("timeMinutesAgo", "5")).toBe("5m ago");
    setCliLocale("zh");
    expect(t("stopPidDone", "1001", "build")).toBe("已停止 pid 1001（build）");
    expect(t("timeMinutesAgo", "5")).toBe("5 分钟前");
  });

  test("altscreen i18n keys exist, non-empty, and differ between locales", () => {
    // 覆盖测试要求 6。新增的 altscreenOn/Off/Usage 在 zh/en 下都要有非空
    // 且互不相同的文案（相同意味着翻译没写）。
    for (const key of ["altscreenOn", "altscreenOff", "altscreenUsage"] as const) {
      setCliLocale("en");
      const en = t(key);
      setCliLocale("zh");
      const zh = t(key);
      expect(en.length, `en copy for ${key}`).toBeGreaterThan(0);
      expect(zh.length, `zh copy for ${key}`).toBeGreaterThan(0);
      expect(zh, `zh === en means ${key} was not translated`).not.toBe(en);
    }
    // helpText 在两种语言下都列出了 /altscreen。
    setCliLocale("en");
    expect(t("helpText")).toContain("/altscreen");
    setCliLocale("zh");
    expect(t("helpText")).toContain("/altscreen");
  });
});
