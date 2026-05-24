import { describe, it, expect, beforeEach } from "vitest";
import { t, getLocale, setLocale } from "../i18n/index.js";
import type { Locale } from "../i18n/index.js";

describe("i18n", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("returns English by default", () => {
    expect(t("cli.no_provider")).toBe("No LLM provider configured.");
  });

  it("returns Korean when locale set to ko", () => {
    setLocale("ko");
    expect(t("cli.no_provider")).toBe("LLM 프로바이더가 설정되지 않았습니다.");
  });

  it("returns Japanese", () => {
    expect(t("cli.no_provider", "ja")).toBe("LLMプロバイダーが設定されていません。");
  });

  it("falls back to English for unsupported locale", () => {
    expect(t("cli.no_provider", "fr" as Locale)).toBe("Aucun fournisseur LLM configuré.");
  });

  it("returns key for unknown translation key", () => {
    expect(t("cli.nonexistent" as "cli.no_provider")).toBe("cli.nonexistent");
  });

  it("getLocale returns en when no env set", () => {
    setLocale(undefined as unknown as Locale);
    expect(getLocale()).toBe("en");
  });

  it("setLocale overrides env", () => {
    setLocale("ko");
    expect(getLocale()).toBe("ko");
  });

  it("wizard keys exist in both ko and en", () => {
    expect(t("wizard.welcome", "en")).toBeTruthy();
    expect(t("wizard.welcome", "ko")).toBeTruthy();
    expect(t("wizard.done", "en")).toBeTruthy();
    expect(t("wizard.done", "ko")).toBeTruthy();
  });

  it("skill description keys exist", () => {
    expect(t("skill.time.description", "en")).toBeTruthy();
    expect(t("skill.weather.description", "ko")).toBeTruthy();
  });
});
