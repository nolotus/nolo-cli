import { afterEach, describe, expect, test } from "bun:test";
import { formatAgentSourceLabel } from "./agentCatalog";
import {
  agentRunCardLabels,
  getCliLocale,
  initCliLocale,
  newlineHint,
  parseCliLocale,
  setCliLocale,
  t,
  toolLabel,
} from "./i18n";

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
    expect(t("welcomeHint")).toContain(newlineHint());
    setCliLocale("zh");
    expect(t("welcomeHint")).toContain("换行");
  });

  test("newlineHint adapts to platform", () => {
    expect(newlineHint("win32")).toBe("Ctrl+J");
    expect(newlineHint("darwin")).toBe("Shift+Enter");
    expect(newlineHint("linux")).toBe("Shift+Enter");
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
    "compactDone",
    "compactDoneNoSummary",
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

  test("dialog confirm and action gate completion keys exist and differ between locales", () => {
    const keys = [
      "dialogConfirmExternalFileTitle",
      "dialogConfirmExternalFileBody",
      "actionGateNeeded",
      "actionGateEnterHint",
      "actionGateInteractiveTitle",
      "actionGateInteractiveBody",
      "agentSourcePlatform",
      "agentSourceSubscription",
      "agentSourceApi",
    ] as const;

    for (const key of keys) {
      setCliLocale("en");
      const en = t(key);
      setCliLocale("zh");
      const zh = t(key);
      expect(en.length, `en copy for ${key}`).toBeGreaterThan(0);
      expect(zh.length, `zh copy for ${key}`).toBeGreaterThan(0);
      if (key !== "agentSourceApi") {
        expect(zh, `zh === en means ${key} was not translated`).not.toBe(en);
      }
    }

    setCliLocale("zh");
    expect(t("dialogConfirmExternalFileTitle")).toBe("确认读取工作区外部文件");
    expect(t("dialogConfirmExternalFileBody")).toBe("该路径位于当前工作区之外。确认后本次访问放行，否则拒绝。");
    expect(t("actionGateNeeded")).toBe("终端需要你的操作");
    expect(t("actionGateEnterHint")).toBe("按 Enter 立即执行，按下方提示操作，或按 Ctrl+C 取消。");
    expect(t("actionGateInteractiveTitle")).toBe("该命令需要交互式终端");
    expect(t("actionGateInteractiveBody")).toBe("在终端中完成操作后，nolo 将继续。");

    setCliLocale("en");
    expect(t("dialogConfirmExternalFileTitle")).toBe("Confirm reading a file outside the workspace");
    expect(t("dialogConfirmExternalFileBody")).toBe("This path is outside the current workspace. Allow this one-time access, or deny it.");
    expect(t("actionGateNeeded")).toBe("Action needed in your terminal");
    expect(t("actionGateEnterHint")).toBe("Press Enter to run it now. Follow any prompts below, or Ctrl+C to cancel.");
    expect(t("actionGateInteractiveTitle")).toBe("This command requires an interactive terminal.");
    expect(t("actionGateInteractiveBody")).toBe("Complete it in the terminal, then nolo will continue.");
  });

  test("formatAgentSourceLabel is localized according to current locale", () => {
    const platformEntry = { name: "test", key: "k", model: "m", kind: "platform" as const };
    const cliEntry = { name: "test", key: "k", model: "m", kind: "private" as const, apiSource: "cli", cliProvider: "copilot" };
    const cliNoProviderEntry = { name: "test", key: "k", model: "m", kind: "private" as const, apiSource: "cli" };
    const customEntry = { name: "test", key: "k", model: "m", kind: "private" as const, apiSource: "custom" };

    setCliLocale("zh");
    expect(formatAgentSourceLabel(platformEntry)).toBe("平台");
    expect(formatAgentSourceLabel(cliEntry)).toBe("订阅(copilot)");
    expect(formatAgentSourceLabel(cliNoProviderEntry)).toBe("订阅");
    expect(formatAgentSourceLabel(customEntry)).toBe("API");

    setCliLocale("en");
    expect(formatAgentSourceLabel(platformEntry)).toBe("Platform");
    expect(formatAgentSourceLabel(cliEntry)).toBe("Subscription(copilot)");
    expect(formatAgentSourceLabel(cliNoProviderEntry)).toBe("Subscription");
    expect(formatAgentSourceLabel(customEntry)).toBe("API");
  });

  test("toolLabel tree categories and agentRunCardLabels are localized", () => {
    setCliLocale("en");
    expect(toolLabel("searchFiles")).toBe("Search");
    expect(toolLabel("readFile")).toBe("Read");
    expect(toolLabel("execShell")).toBe("Run");
    expect(toolLabel("fetchWebpage")).toBe("Fetch");
    expect(toolLabel("fetchWebpage")).toBe("Fetch");
    expect(toolLabel("exa_search")).toBe("Web search");
    expect(agentRunCardLabels().runStatus).toBe("Run status");
    expect(agentRunCardLabels().runs(3)).toBe("Runs (3)");

    setCliLocale("zh");
    expect(toolLabel("searchFiles")).toBe("搜索");
    expect(toolLabel("readFile")).toBe("读取");
    expect(toolLabel("execShell")).toBe("执行");
    expect(toolLabel("fetchWebpage")).toBe("抓取网页");
    expect(toolLabel("fetchWebpage")).toBe("抓取网页");
    expect(toolLabel("exa_search")).toBe("联网搜索");
    expect(agentRunCardLabels().runStatus).toBe("运行状态");
    expect(agentRunCardLabels().logTail).toBe("日志尾部：");
    expect(agentRunCardLabels().runs(3)).toBe("运行 (3)");
  });
});
