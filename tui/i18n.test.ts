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
});
