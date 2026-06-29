// domain — 환경 세그먼트(클라 제공 환경고유 컨텍스트) → system prompt 블록 합성(순수, 외부 의존 없음).
//
// S4(계약 C2): 클라(naia-os)는 환경고유 정보를 *raw systemPrompt 에 굽지 않고* 구조화 EnvironmentSegment 로
// 보낸다. 코어가 persona + workspaceContext 뒤에 이 블록을 결정론 머지한다. 권한 모델 — environmentSegments
// **만** 클라 제공이며 그것도 kind 별 구조화 값(자유 system-prompt 텍스트 금지). 화이트리스트(avatarEmotion|panel)
// 외 kind 는 드롭한다.
//
//  - avatarEmotion: naia-os 아바타 모드. 코어가 **표준 emotion-tag 지시문을 자체 발행**(naia-os
//    getEmotionInstructions 문자열 이식 — 문구 SoT 가 코어로 이동). CLI 는 아바타가 없어 이 세그먼트를 안 보냄.
//  - panel: 런타임 UI 패널 컨텍스트. "참고 데이터"로 격리·이스케이프(JSON.stringify + 길이 제한) — 모델 지시문이
//    아니라 컨텍스트로 명시 라벨링(naia-os buildSystemPrompt 의 `Panel [type] context: <json>` 거울).
//  - responseStyle: 환경 응답 스타일 힌트(음성 파이프라인=brief). 코어가 표준 간결성 지시문을 *자체 발행*(문구 SoT
//    가 코어). brief=짧은 구어 응답 지시 1줄, normal=무영향. 음성 STT→채팅 경로가 raw systemPrompt 로 persona 를
//    덮던 두벌(S4 회귀)을 제거 — persona+workspace 조립을 보존하면서 간결성만 환경 블록으로 append.
//
// ★ 인젝션 차단(C2, codex 적대리뷰): 클라 제공 *라벨*(panel.type)·*데이터*(panel.data) 는 모델 지시문이 아니라
//   참고 컨텍스트다. 개행·제어문자 삽입으로 "IMPORTANT: ignore persona" 같은 자유 시스템 지시를 라벨/데이터에
//   심을 수 없게 — 라벨은 sanitizeLabel(개행/제어/`[`/`]` 제거 + 길이 cap), 데이터 한 줄(JSON.stringify 는 개행을
//   \n 으로 이스케이프하나 방어적 1줄 강제) 로 강제한다. 또 세그먼트 개수·entry 개수·렌더 총길이를 cap 으로 묶어
//   대량 입력이 persona 뒤를 잠식하지 못하게 한다(상수 명시).

import type { EnvironmentSegment } from "./chat.js";

/** 음성 모드 간결성 지시(코어 소유 문구) — responseStyle=brief 일 때 발행. persona 조립을 덮지 않고 그 뒤에 append. */
const BRIEF_RESPONSE_INSTRUCTION =
  "Keep responses concise and brief (voice mode — short spoken answers).";

/** panel 데이터 1건의 JSON 직렬화 길이 상한(토큰 bounded — 비대 패널 페이로드가 프롬프트를 잠식 못 하게). */
export const PANEL_ENTRY_JSON_CAP = 2000;

/** panel.type(라벨) 새니타이즈 후 최대 길이(자유 system-prompt 텍스트 운반 차단 — 라벨은 짧은 식별자). */
export const PANEL_TYPE_LABEL_CAP = 64;
/** 처리할 환경 세그먼트 최대 개수(대량 세그먼트로 persona 뒤를 잠식하는 것 차단 — 초과분 드롭). */
export const MAX_SEGMENTS = 8;
/** panel 1건당 처리할 entry 최대 개수(대량 entry 잠식 차단 — 초과분 드롭). */
export const MAX_PANEL_ENTRIES = 16;
/** 렌더 총길이 상한(전체 환경 블록이 persona 를 잠식 못 하게 — 초과 시 절단 + 마커). */
export const MAX_RENDER_CHARS = 4000;

/**
 * 제어문자(개행·탭·CR 포함) 판정 — U+0000~001F 와 U+007F~009F. 라벨/한줄강제 새니타이즈 공용.
 * (regex 제어문자 리터럴 회피 — 코드포인트 비교로 결정론·가독.)
 */
function isControlChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** 클라 제공 문자열에서 제어문자(개행 포함)를 모두 제거해 단일 라인으로 강제(domain 순수). */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isControlChar(ch.codePointAt(0)!)) out += ch;
  }
  return out;
}

/**
 * 라벨 새니타이즈(C2 인젝션 차단, domain 순수) — panel.type 처럼 *라벨 위치*에 들어가는 클라 제공 문자열을
 * 개행/제어문자·라벨 구조문자(`[`/`]`)를 제거해 한 줄 식별자로 강제(개행+"IMPORTANT: ignore persona" 같은
 * 자유 시스템 지시 삽입 차단). 결과는 단일 라인·길이 cap(PANEL_TYPE_LABEL_CAP). 정상 라벨(영문/한글/숫자/
 * 하이픈/언더스코어 등)은 무손실 통과(새니타이즈가 정상값을 망가뜨리지 않음).
 */
export function sanitizeLabel(s: string): string {
  const stripped = stripControlChars(s).split("[").join("").split("]").join("");
  return stripped.length > PANEL_TYPE_LABEL_CAP ? stripped.slice(0, PANEL_TYPE_LABEL_CAP) : stripped;
}

/** locale 별 emotion-tag 예시 문장(naia-os getEmotionExample 거울). 미지원 locale=영어 폴백. */
function getEmotionExample(locale?: string): string {
  const examples: Record<string, string> = {
    ko: "[HAPPY] 좋은 아침이에요! 오늘 뭘 하고 싶어요?",
    en: "[HAPPY] Good morning! What would you like to do today?",
    ja: "[HAPPY] おはようございます！今日は何をしたいですか？",
    zh: "[HAPPY] 早上好！今天想做什么？",
    fr: "[HAPPY] Bonjour ! Qu'est-ce que tu veux faire aujourd'hui ?",
    de: "[HAPPY] Guten Morgen! Was möchtest du heute machen?",
    ru: "[HAPPY] Доброе утро! Чем хотите заняться сегодня?",
    es: "[HAPPY] ¡Buenos días! ¿Qué quieres hacer hoy?",
    ar: "[HAPPY] صباح الخير! ماذا تريد أن تفعل اليوم؟",
    hi: "[HAPPY] सुप्रभात! आज आप क्या करना चाहेंगे?",
    bn: "[HAPPY] সুপ্রভাত! আজ কী করতে চান?",
    pt: "[HAPPY] Bom dia! O que você gostaria de fazer hoje?",
    id: "[HAPPY] Selamat pagi! Apa yang ingin kamu lakukan hari ini?",
    vi: "[HAPPY] Chào buổi sáng! Hôm nay bạn muốn làm gì?",
  };
  return examples[locale ?? "en"] ?? examples.en!;
}

/**
 * 표준 emotion-tag 지시문(아바타 전용) — naia-os getEmotionInstructions 거울(문구 SoT 가 코어로 이동).
 * 코어가 *자체 발행*(클라는 avatarEmotion capability flag 만). 선행 개행은 join 이 흡수하도록 trim.
 */
function emotionInstructions(locale?: string): string {
  const example = getEmotionExample(locale);
  return `Emotion tags (for Shell avatar only):
- Prepend EXACTLY ONE emotion tag at the start of each response
- Available tags: [HAPPY] [SAD] [ANGRY] [SURPRISED] [NEUTRAL] [THINK]
- Example: "${example}"
- Use [THINK] when reasoning through complex questions
- Use [NEUTRAL] for straightforward factual answers
- Default to [HAPPY] for greetings and positive interactions
- IMPORTANT: Emotion tags are for the Shell avatar's facial expression only. They are automatically stripped from Discord messages.`;
}

/**
 * panel data 를 안전 직렬화 — JSON.stringify 실패(순환참조 등)는 "[unserializable]", 상한 초과는 절단.
 * JSON.stringify 는 문자열 내부 개행을 \n(2문자)로 이스케이프하므로 한 줄이지만, 방어적으로 제어문자를
 * 한 번 더 제거(어떤 직렬화 경로로든 raw 개행이 라벨 줄을 쪼개 지시문처럼 보이지 않게 — C2).
 */
function safePanelData(data: unknown): string {
  let s: string;
  try { s = JSON.stringify(data ?? null); } catch { return "[unserializable]"; }
  if (s.length > PANEL_ENTRY_JSON_CAP) s = `${s.slice(0, PANEL_ENTRY_JSON_CAP)}…[truncated]`;
  return stripControlChars(s);
}

/** 렌더 총길이를 MAX_RENDER_CHARS 로 cap(초과 시 절단 + 마커) — 환경 블록이 persona 를 잠식 못 하게. */
function capRender(s: string): string {
  if (s.length <= MAX_RENDER_CHARS) return s;
  return `${s.slice(0, MAX_RENDER_CHARS)}…[truncated]`;
}

/**
 * EnvironmentSegment[] → system prompt 블록(순수). persona ⊕ workspaceContext **뒤에 append** 되는 환경 블록.
 * - 빈 입력 또는 유효 세그먼트 0 → "" (append 할 컨텍스트 없음 = 무영향).
 * - avatarEmotion → 표준 emotion-tag 지시문(코어 소유 문구, locale 별 예시).
 * - panel → 각 entry 를 `Panel [type] context: <escaped json>` 한 줄로(참고데이터 라벨, 길이 bounded·라벨 새니타이즈).
 * - responseStyle → brief 면 간결성 지시 1줄(코어 소유 문구), normal 은 무영향(블록 미생성).
 * - 화이트리스트 외 kind 는 타입상 도달 불가(폐쇄 union)이나, 방어적으로 default 에서 드롭.
 *
 * ★ cap(C2): 세그먼트는 MAX_SEGMENTS, panel entry 는 MAX_PANEL_ENTRIES 까지만 처리(초과 드롭), 렌더 총길이는
 *   MAX_RENDER_CHARS 로 절단 — 대량 입력이 persona 뒤를 잠식하는 것 차단.
 *
 * 순서: 입력 세그먼트 순서 유지(naia-os 가 [avatarEmotion, panel] 순으로 보냄 — buildSystemPrompt 의
 * Context(panel) → emotion 순서와 다르나, 코어 조립에선 persona+Context 가 이미 persona 단계에서 끝났고
 * 환경 블록은 그 뒤 별도 섹션이라 panel/emotion 상대순서는 의미 동등 — golden 대조로 확인).
 */
export function renderEnvironmentSegments(
  segs: readonly EnvironmentSegment[],
  locale?: string,
): string {
  const blocks: string[] = [];
  // 세그먼트 개수 cap — 초과분 드롭(대량 세그먼트 잠식 차단).
  for (const seg of segs.slice(0, MAX_SEGMENTS)) {
    switch (seg.kind) {
      case "avatarEmotion":
        blocks.push(emotionInstructions(locale));
        break;
      case "panel": {
        const lines = seg.entries
          .slice(0, MAX_PANEL_ENTRIES) // entry 개수 cap — 초과분 드롭(대량 entry 잠식 차단).
          .filter((e) => e && typeof e.type === "string")
          .map((e) => `Panel [${sanitizeLabel(e.type)}] context: ${safePanelData(e.data)}`); // 라벨 새니타이즈(C2).
        if (lines.length > 0) blocks.push(lines.join("\n"));
        break;
      }
      case "responseStyle":
        // brief → 간결성 지시 1줄(코어 소유). normal → 무영향(블록 미생성, 기본 동작).
        if (seg.style === "brief") blocks.push(BRIEF_RESPONSE_INSTRUCTION);
        break;
      default:
        // 폐쇄 union 이라 도달 불가(컴파일타임). 런타임 미지 kind 는 드롭(방어).
        break;
    }
  }
  if (blocks.length === 0) return "";
  return capRender(blocks.join("\n\n")); // 렌더 총길이 cap(C2).
}
