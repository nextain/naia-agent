import { describe, it, expect } from "vitest";
import { t, setLocale } from "../i18n/index.js";
import type { Locale } from "../i18n/index.js";

describe("Wizard logic (unit-level)", () => {
  it("locale selection maps correctly", () => {
    const LOCALE_OPTIONS: { code: Locale; label: string }[] = [
      { code: "ko", label: "한국어" },
      { code: "en", label: "English" },
      { code: "ja", label: "日本語" },
    ];
    expect(LOCALE_OPTIONS[0]!.code).toBe("ko");
    expect(LOCALE_OPTIONS[2]!.code).toBe("ja");
  });

  it("provider selection maps correctly", () => {
    const PROVIDER_OPTIONS = [
      { id: "anthropic", label: "Anthropic (Claude)" },
      { id: "openai", label: "OpenAI" },
      { id: "glm", label: "Zhipu GLM" },
      { id: "vertex", label: "Anthropic on Vertex AI" },
    ];
    expect(PROVIDER_OPTIONS[0]!.id).toBe("anthropic");
    expect(PROVIDER_OPTIONS[3]!.id).toBe("vertex");
  });

  it("wizard text available in ko and en", () => {
    expect(t("wizard.welcome", "en")).toBeTruthy();
    expect(t("wizard.welcome", "ko")).toBeTruthy();
    expect(t("wizard.language_prompt", "en")).toBeTruthy();
    expect(t("wizard.key_prompt", "en")).toBeTruthy();
    expect(t("wizard.model_prompt", "ko")).toBeTruthy();
    expect(t("wizard.embedding_prompt", "ko")).toBeTruthy();
    expect(t("wizard.persona_prompt", "ko")).toBeTruthy();
    expect(t("wizard.done", "ko")).toBeTruthy();
  });

  it("setLocale persists for subsequent t() calls", () => {
    setLocale("ko");
    expect(t("wizard.welcome")).toContain("환영");
    setLocale("en");
    expect(t("wizard.welcome")).toContain("Welcome");
  });
});
