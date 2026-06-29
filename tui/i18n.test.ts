import { afterEach, describe, expect, test } from "bun:test";
import { getCliLocale, setCliLocale, t } from "./i18n";

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
    expect(t("placeholder")).toBe("输入消息或 / 查看命令...");
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
});
