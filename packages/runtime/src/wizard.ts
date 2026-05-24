import * as readline from "node:readline";
import { t, setLocale, getLocale } from "./i18n/index.js";
import type { Locale } from "./i18n/index.js";

export interface WizardResult {
  locale: Locale;
  provider: string;
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  persona?: string;
}

const LOCALE_OPTIONS: { code: Locale; label: string }[] = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];

const PROVIDER_OPTIONS = [
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI" },
  { id: "glm", label: "Zhipu GLM" },
  { id: "vertex", label: "Anthropic on Vertex AI" },
];

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export async function runWizard(): Promise<WizardResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(t("wizard.welcome"));
  console.log("");

  console.log(t("wizard.language_prompt"));
  LOCALE_OPTIONS.forEach((opt, i) => {
    console.log(`  ${i + 1}. ${opt.label}`);
  });
  const langChoice = await prompt(rl, "> ");
  const langIdx = parseInt(langChoice, 10) - 1;
  const locale = LOCALE_OPTIONS[langIdx]?.code ?? "en";
  setLocale(locale);
  console.log("");

  console.log(t("wizard.key_prompt"));
  PROVIDER_OPTIONS.forEach((opt, i) => {
    console.log(`  ${i + 1}. ${opt.label}`);
  });
  const provChoice = await prompt(rl, "> ");
  const provIdx = parseInt(provChoice, 10) - 1;
  const provider = PROVIDER_OPTIONS[provIdx]?.id ?? "anthropic";

  const envKeyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    glm: "GLM_API_KEY",
    vertex: "VERTEX_PROJECT_ID",
  };
  console.log(`\n${envKeyMap[provider]}:`);
  const apiKey = await prompt(rl, "> ");

  console.log(`\n${t("wizard.model_prompt")} (optional, press Enter to skip)`);
  const model = await prompt(rl, "> ");

  console.log(`\n${t("wizard.embedding_prompt")} (optional, press Enter to skip)`);
  const embeddingModel = await prompt(rl, "> ");

  console.log(`\n${t("wizard.persona_prompt")} (optional, press Enter to skip)`);
  const persona = await prompt(rl, "> ");

  rl.close();

  console.log(`\n${t("wizard.done")}`);

  return {
    locale,
    provider,
    apiKey,
    ...(model ? { model } : {}),
    ...(embeddingModel ? { embeddingModel } : {}),
    ...(persona ? { persona } : {}),
  };
}
