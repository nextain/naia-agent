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

import type { EnvironmentSegment } from "./chat.js";

/** 음성 모드 간결성 지시(코어 소유 문구) — responseStyle=brief 일 때 발행. persona 조립을 덮지 않고 그 뒤에 append. */
const BRIEF_RESPONSE_INSTRUCTION =
  "Keep responses concise and brief (voice mode — short spoken answers).";

/** panel 데이터 1건의 JSON 직렬화 길이 상한(토큰 bounded — 비대 패널 페이로드가 프롬프트를 잠식 못 하게). */
export const PANEL_ENTRY_JSON_CAP = 2000;

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

/** panel data 를 안전 직렬화 — JSON.stringify 실패(순환참조 등)는 "[unserializable]", 상한 초과는 절단. */
function safePanelData(data: unknown): string {
  let s: string;
  try { s = JSON.stringify(data ?? null); } catch { return "[unserializable]"; }
  if (s.length > PANEL_ENTRY_JSON_CAP) return `${s.slice(0, PANEL_ENTRY_JSON_CAP)}…[truncated]`;
  return s;
}

/**
 * EnvironmentSegment[] → system prompt 블록(순수). persona ⊕ workspaceContext **뒤에 append** 되는 환경 블록.
 * - 빈 입력 또는 유효 세그먼트 0 → "" (append 할 컨텍스트 없음 = 무영향).
 * - avatarEmotion → 표준 emotion-tag 지시문(코어 소유 문구, locale 별 예시).
 * - panel → 각 entry 를 `Panel [type] context: <escaped json>` 한 줄로(참고데이터 라벨, 길이 bounded).
 * - responseStyle → brief 면 간결성 지시 1줄(코어 소유 문구), normal 은 무영향(블록 미생성).
 * - 화이트리스트 외 kind 는 타입상 도달 불가(폐쇄 union)이나, 방어적으로 default 에서 드롭.
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
  for (const seg of segs) {
    switch (seg.kind) {
      case "avatarEmotion":
        blocks.push(emotionInstructions(locale));
        break;
      case "panel": {
        const lines = seg.entries
          .filter((e) => e && typeof e.type === "string")
          .map((e) => `Panel [${e.type}] context: ${safePanelData(e.data)}`);
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
  return blocks.join("\n\n");
}
