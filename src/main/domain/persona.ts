// domain — 워크스페이스 페르소나 → system prompt 합성(순수, 외부 의존 없음).
//
// naia-os packages/shell/src/lib/persona.ts `buildSystemPrompt()` 의 합성 순서·문자열을 **재구현**(import
// 금지 — 별도 패키지·다른 fork 의존 회피, 헥사고날 domain 순수성). 단, 아바타/환경 전용 **emotion-tag 블록은
// 제외**한다 — CLI(naia-agent-chat)는 아바타가 없으므로(naia-os 전용 분기). discord/panel 등 다른 환경 블록도
// 미포함(코어는 환경 비종속).
//
// 정본(루크): 페르소나 SoT = `<adkPath>/naia-settings/config.json` (naia-os 가 읽고 쓰는 동일 파일).
// 이 도메인 함수는 그 config 에서 어댑터(persona-source-store)가 추출한 PersonaProfile 만 받아 순수 합성한다.

/** formal/informal 화법 구분이 의미 있는 locale(naia-os FORMALITY_LOCALES 거울). */
const FORMALITY_LOCALES = new Set([
  "ko", "ja", "de", "fr", "es", "hi", "vi", "ru", "pt", "id", "ar",
]);

/** locale code → 영문 언어명(naia-os localeToLanguage 거울). */
function localeToLanguage(locale: string): string {
  const map: Record<string, string> = {
    ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese",
    fr: "French", de: "German", ru: "Russian", es: "Spanish",
    ar: "Arabic", hi: "Hindi", bn: "Bengali", pt: "Portuguese",
    id: "Indonesian", vi: "Vietnamese",
  };
  return map[locale] || "English";
}

/** locale+style → 화법 지시(naia-os getSpeechStyleInstruction 거울). */
function getSpeechStyleInstruction(locale: string, style: string): string {
  const lang = localeToLanguage(locale);
  const casual: Record<string, string> = {
    ko: "IMPORTANT: Speak casually in Korean (반말). Do NOT use 존댓말.",
    ja: "IMPORTANT: Speak casually in Japanese (タメ口). Do NOT use 敬語.",
    de: "IMPORTANT: Speak casually using 'du' in German. Do NOT use 'Sie'.",
    fr: "IMPORTANT: Speak casually using 'tu' in French. Do NOT use 'vous'.",
    es: "IMPORTANT: Speak casually using 'tú' in Spanish. Do NOT use 'usted'.",
    hi: "IMPORTANT: Speak casually using 'तुम' in Hindi. Do NOT use 'आप'.",
    vi: "IMPORTANT: Speak casually using informal pronouns in Vietnamese.",
    ru: "IMPORTANT: Speak casually using 'ты' in Russian. Do NOT use 'вы'.",
    pt: "IMPORTANT: Speak casually using 'tu/você' in Portuguese. Do NOT use 'senhor/senhora'.",
    id: "IMPORTANT: Speak casually using 'kamu' in Indonesian. Do NOT use 'Anda'.",
    ar: "IMPORTANT: Speak casually using 'أنت' in Arabic. Do NOT use 'حضرتك'.",
  };
  const formal: Record<string, string> = {
    ko: "IMPORTANT: Speak politely in Korean (존댓말). Do NOT use 반말.",
    ja: "IMPORTANT: Speak politely in Japanese (敬語/丁寧語). Do NOT use タメ口.",
    de: "IMPORTANT: Speak formally using 'Sie' in German. Do NOT use 'du'.",
    fr: "IMPORTANT: Speak formally using 'vous' in French. Do NOT use 'tu'.",
    es: "IMPORTANT: Speak formally using 'usted' in Spanish. Do NOT use 'tú'.",
    hi: "IMPORTANT: Speak formally using 'आप' in Hindi. Do NOT use 'तुम/तू'.",
    vi: "IMPORTANT: Speak formally using honorific pronouns in Vietnamese.",
    ru: "IMPORTANT: Speak formally using 'вы' in Russian. Do NOT use 'ты'.",
    pt: "IMPORTANT: Speak formally using 'senhor/senhora' in Portuguese.",
    id: "IMPORTANT: Speak formally using 'Anda' in Indonesian. Do NOT use 'kamu'.",
    ar: "IMPORTANT: Speak formally using 'حضرتك' in Arabic.",
  };
  if (style === "casual") {
    return casual[locale] ?? `IMPORTANT: Speak casually in ${lang}.`;
  }
  return formal[locale] ?? `IMPORTANT: Speak formally in ${lang}.`;
}

/**
 * 워크스페이스 페르소나 프로필 — config.json + 내장 persona JSON 에서 추출한 합성 입력(어댑터가 매핑).
 * 모든 필드 옵셔널: 부재 시 해당 컨텍스트 줄/치환 생략(degrade). systemPromptPrefix 우선, 없으면 personaText.
 */
export interface PersonaProfile {
  /** 에이전트 이름(예: "알파"). base 의 "Naia (낸)"/"Nan" 치환에 사용. */
  agentName?: string;
  /** 사용자 이름(예: "루크"). */
  userName?: string;
  /** 호칭(예: "마스터"). formality locale 에서만 적용. */
  honorific?: string;
  /** "formal" | "casual". formality locale 에서만 화법 지시 생성. */
  speechStyle?: string;
  /** locale code(예: "ko" — config.NAIA_LOCALE). */
  locale?: string;
  /** persona JSON 의 systemPromptPrefix(권위 페르소나 지시) — 있으면 base 로 우선. */
  systemPromptPrefix?: string;
  /** 폴백 base — persona 원문(string) 또는 별도 페르소나 텍스트. systemPromptPrefix 부재 시 사용. */
  personaText?: string;
}

/**
 * PersonaProfile → 합성된 system prompt(순수). naia-os buildSystemPrompt 의 합성 순서를 거울로 하되
 * **emotion-tag 블록(아바타 전용)은 제외**. profile 이 사실상 비어 base 가 없으면 `""` 반환(호출자가
 * "페르소나 기본 없음"으로 취급 → CLI 가 systemPrompt 미설정).
 *
 * 합성 순서:
 *  1. base = systemPromptPrefix ?? personaText (둘 다 없으면 base 없음 → "" 가능)
 *  2. agentName 치환("Naia (낸)"·"Nan" → agentName)
 *  3. Context: userName → honorific(formality locale 만) → locale("Respond in <Lang>") → speechStyle(formality locale 만)
 */
export function composePersonaPrompt(profile: PersonaProfile): string {
  const baseRaw = (profile.systemPromptPrefix ?? profile.personaText ?? "").trim();
  // base 가 없으면(빈 profile 또는 페르소나 텍스트 부재) 컨텍스트만으로 system prompt 를 만들지 않는다 —
  // "페르소나 기본 없음" = "" 반환(naia-os 는 DEFAULT_PERSONA 폴백이 있으나 CLI 는 generic 유지가 기본).
  if (!baseRaw) return "";

  let base = baseRaw;
  if (profile.agentName) {
    base = base.replace(/Naia\s*\(낸\)/g, profile.agentName);
    base = base.replace(/\bNan\b/g, profile.agentName);
  }

  const parts = [base];
  const contextLines: string[] = [];

  if (profile.userName) {
    contextLines.push(
      `The user's name is "${profile.userName}". Address them by name occasionally.`,
    );
  }

  if (
    profile.honorific &&
    (!profile.locale || FORMALITY_LOCALES.has(profile.locale))
  ) {
    const lang = profile.locale ? localeToLanguage(profile.locale) : "the user's language";
    contextLines.push(
      `Address the user as "${profile.honorific} ${profile.userName || ""}" or "${profile.userName || ""}${profile.honorific}" as appropriate for ${lang}.`,
    );
  }

  if (profile.locale) {
    const lang = localeToLanguage(profile.locale);
    contextLines.push(
      `IMPORTANT: Respond in ${lang}. The user's preferred language is ${lang}.`,
    );
  }

  if (
    profile.speechStyle &&
    (!profile.locale || FORMALITY_LOCALES.has(profile.locale))
  ) {
    contextLines.push(getSpeechStyleInstruction(profile.locale || "ko", profile.speechStyle));
  }

  if (contextLines.length > 0) {
    parts.push(`\nContext:\n${contextLines.join("\n")}`);
  }

  // ⚠️ naia-os 는 여기서 getEmotionInstructions(아바타 표정 태그)를 append 하지만, CLI 는 아바타가 없어
  //    의도적으로 **제외**한다(UC-PERSONA-CLI / FR-PERSONA-1, NFR-PERSONA-no-import).
  return parts.join("\n");
}
