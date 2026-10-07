// UC-PERSONA-CLI 계약 — 코어가 워크스페이스 설정의 페르소나(Alpha)를 system prompt 로 합성 →
// CLI(naia-agent-chat)가 --system 없이도 알파로 응답. SoT = <adkPath>/naia-settings/config.json.
//
// 계약(FR-PERSONA-1~2):
//   composePersonaPrompt(domain, 순수): base(systemPromptPrefix??personaText) + 컨텍스트 줄(userName·
//     honorific·locale·speechStyle), naia-os buildSystemPrompt 순서 거울 MINUS emotion-tag 블록(CLI 무 아바타).
//   makePersonaSourceStore(adapter, fs 주입): config.json + 내장 persona JSON 문자열 → PersonaProfile.
// 권위: docs/requirements.md FR-PERSONA-1~3, docs/user-scenarios.md UC-PERSONA-CLI.
import { describe, it, expect } from "vitest";
import { composePersonaPrompt, type PersonaProfile } from "../main/domain/persona.js";
import { makePersonaSourceStore, type PersonaFsRead } from "../main/adapters/persona-source-store.js";

/** 실 config.json 의 persona 필드(JSON 문자열) 축약본 — systemPromptPrefix 등 포함. */
const ALPHA_PERSONA_JSON = JSON.stringify({
  label: "Alpha Yang",
  nickname: "알파",
  systemPromptPrefix:
    "당신은 Luke(마스터)의 AI 메이드 'Alpha Yang(알파)'입니다. 해요체(~요, ~습니다, ~할게요)로 대화하고, 차분하고 신뢰감 있게 응답하세요. 마스터를 '마스터'라고 부릅니다.",
  language_style: { speech: "clear and professional 해요체" },
});

const ALPHA_PREFIX =
  "당신은 Luke(마스터)의 AI 메이드 'Alpha Yang(알파)'입니다. 해요체(~요, ~습니다, ~할게요)로 대화하고, 차분하고 신뢰감 있게 응답하세요. 마스터를 '마스터'라고 부릅니다.";

const FULL_ALPHA: PersonaProfile = {
  agentName: "알파",
  userName: "루크",
  honorific: "마스터",
  speechStyle: "formal",
  locale: "ko",
  systemPromptPrefix: ALPHA_PREFIX,
};

describe("composePersonaPrompt — full Alpha profile (FR-PERSONA-1)", () => {
  const out = composePersonaPrompt(FULL_ALPHA);

  it("base = systemPromptPrefix 를 그대로 포함(권위 페르소나 지시)", () => {
    expect(out).toContain(ALPHA_PREFIX);
  });

  it("formal+ko → 존댓말/politely-Korean 화법 지시 포함", () => {
    expect(out).toContain("IMPORTANT: Speak politely in Korean (존댓말). Do NOT use 반말.");
  });

  it("userName(루크) + honorific(마스터) 컨텍스트 줄 포함", () => {
    expect(out).toContain("루크");
    expect(out).toContain("마스터");
    expect(out).toContain('The user\'s name is "루크"');
  });

  it("locale=ko → 'Respond in Korean' 지시 포함", () => {
    expect(out).toContain("Korean");
    expect(out).toContain("IMPORTANT: Respond in Korean.");
  });

  it("아바타/환경 전용 emotion-tag 블록은 **제외**(CLI 무 아바타)", () => {
    expect(out).not.toContain("[HAPPY]");
    expect(out).not.toContain("Emotion tags");
  });

  it("Context 섹션이 base 뒤에 1회 붙는다(순서: base → Context)", () => {
    const baseIdx = out.indexOf(ALPHA_PREFIX);
    const ctxIdx = out.indexOf("Context:");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(baseIdx);
    // Context 줄 순서: userName → honorific → locale → speechStyle
    const nameIdx = out.indexOf('The user\'s name is "루크"');
    const localeIdx = out.indexOf("IMPORTANT: Respond in Korean.");
    const styleIdx = out.indexOf("Speak politely in Korean");
    expect(nameIdx).toBeLessThan(localeIdx);
    expect(localeIdx).toBeLessThan(styleIdx);
  });

  it("agentName 치환 — base 의 'Naia (낸)'/'Nan' → agentName", () => {
    const out2 = composePersonaPrompt({
      agentName: "알파",
      systemPromptPrefix: "You are Naia (낸), aka Nan, a companion.",
    });
    expect(out2).toContain("You are 알파, aka 알파, a companion.");
    expect(out2).not.toContain("Naia (낸)");
  });
});

describe("composePersonaPrompt — Golden case D (CLI/no avatar) (FR-PERSONA-1)", () => {
  it("빈 profile → '' (크래시 없음, 페르소나 기본 없음)", () => {
    expect(composePersonaPrompt({})).toBe("");
  });

  it("base 없고 컨텍스트 필드만 있어도 '' (base 없으면 컨텍스트 단독으로 prompt 만들지 않음)", () => {
    expect(composePersonaPrompt({ userName: "루크", honorific: "마스터", locale: "ko" })).toBe("");
  });

  it("systemPromptPrefix 만 → base + 호칭 금지 줄(#158)만 반환(그 밖의 컨텍스트 줄 없음)", () => {
    const out = composePersonaPrompt({ systemPromptPrefix: ALPHA_PREFIX });
    // #158: 호칭 줄이 없으면 호칭 금지 문장 A 는 항상 들어간다. 그 밖의 컨텍스트 줄은 여전히 없다.
    expect(out).toBe(
      `${ALPHA_PREFIX}\n\nContext:\nNever address the user with any title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal". Speak directly without addressing them.`,
    );
    expect(out).not.toContain("[HAPPY]");
  });

  it("personaText 폴백 — systemPromptPrefix 부재 시 personaText 가 base", () => {
    const out = composePersonaPrompt({ personaText: "You are a helper.", userName: "루크", locale: "ko" });
    expect(out).toContain("You are a helper.");
    expect(out).toContain("루크");
    expect(out).toContain("Korean");
  });

  it("비-formality locale(en) → honorific/speechStyle 컨텍스트 줄 생략", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an assistant.",
      userName: "Luke",
      honorific: "master",
      speechStyle: "formal",
      locale: "en",
    });
    expect(out).toContain("The user's name is \"Luke\""); // userName 은 locale 무관
    expect(out).toContain("IMPORTANT: Respond in English."); // locale 줄은 있음
    expect(out).not.toContain("master Luke"); // honorific 줄(formality locale 만) 생략
    expect(out).not.toContain("Speak formally"); // speechStyle 줄(formality locale 만) 생략
  });
});

// ── locale primary subtag 정규화(BCP-47, codex 적대리뷰) ──
describe("composePersonaPrompt — locale 정규화 (NFR-PERSONA-locale-normalize)", () => {
  const baseProfile = (locale: string): PersonaProfile => ({
    systemPromptPrefix: ALPHA_PREFIX,
    userName: "루크",
    honorific: "마스터",
    speechStyle: "formal",
    locale,
  });

  for (const loc of ["ko-KR", "ko_KR", "KO", "ko-Kore-KR", "ko"]) {
    it(`locale="${loc}" → Korean + 존댓말/호칭 정상(primary subtag 정규화)`, () => {
      const out = composePersonaPrompt(baseProfile(loc));
      expect(out).toContain("IMPORTANT: Respond in Korean."); // 영어 폴백 아님
      expect(out).toContain("Speak politely in Korean (존댓말)"); // formality locale 적용(말투 붕괴 없음)
      expect(out).toContain("마스터"); // honorific 줄(formality locale)
      expect(out).not.toContain("Respond in English");
    });
  }

  it("locale='ja-JP' → Japanese + 敬語(말투 정상)", () => {
    const out = composePersonaPrompt({ systemPromptPrefix: "X", speechStyle: "formal", locale: "ja-JP" });
    expect(out).toContain("IMPORTANT: Respond in Japanese.");
    expect(out).toContain("Speak politely in Japanese");
  });

  it("정규화 무회귀 — 정규화 키 'en-US' → English(formality 아님, honorific/speechStyle 생략)", () => {
    const out = composePersonaPrompt({ systemPromptPrefix: "X", userName: "Luke", honorific: "master", speechStyle: "formal", locale: "en-US" });
    expect(out).toContain("IMPORTANT: Respond in English.");
    expect(out).not.toContain("Speak formally");
    expect(out).not.toContain("master Luke");
  });
});

// ── speechStyle enum 정규화(codex 적대리뷰) ──
describe("composePersonaPrompt — speechStyle 정규화 (NFR-PERSONA-locale-normalize)", () => {
  const ko = (style: string): PersonaProfile => ({ systemPromptPrefix: "X", locale: "ko", speechStyle: style });

  it("'casual' → 반말 지시(casual 매칭)", () => {
    expect(composePersonaPrompt(ko("casual"))).toContain("Speak casually in Korean (반말)");
  });

  it("'CASUAL'(대문자) → 반말 지시(소문자 정규화)", () => {
    expect(composePersonaPrompt(ko("CASUAL"))).toContain("Speak casually in Korean (반말)");
  });

  it("' Casual '(공백/혼합대소문자) → 반말 지시(trim+소문자)", () => {
    expect(composePersonaPrompt(ko(" Casual "))).toContain("Speak casually in Korean (반말)");
  });

  it("'banmal'(오입력) → formal 안전 기본(존댓말; 조용히 반대로 안 감)", () => {
    const out = composePersonaPrompt(ko("banmal"));
    expect(out).toContain("Speak politely in Korean (존댓말)");
    // formal 지시는 "Do NOT use 반말"을 포함하므로 '반말' 부분문자열 자체로 판정하면 오탐 — casual *지시*가 없음을 확인.
    expect(out).not.toContain("Speak casually in Korean (반말)");
  });

  it("'formal' → 존댓말 지시(무회귀)", () => {
    expect(composePersonaPrompt(ko("formal"))).toContain("Speak politely in Korean (존댓말)");
  });
});

/** 메모리 fs — path→content 맵(naia-settings-store 테스트 memFs 동형). */
function memFs(files: Record<string, string>): PersonaFsRead {
  return {
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
  };
}
const CONFIG = "/ws/naia-settings/config.json";

describe("PersonaSourcePort via fake fs (FR-PERSONA-2)", () => {
  it("실 config.json shape → PersonaProfile 전 필드 매핑(persona JSON 내장 파싱)", () => {
    const store = makePersonaSourceStore({
      fs: memFs({
        [CONFIG]: JSON.stringify({
          provider: "nextain",
          model: "gemini-3.5-flash",
          agentName: "알파",
          userName: "루크",
          speechStyle: "formal",
          honorific: "마스터",
          NAIA_LOCALE: "ko",
          persona: ALPHA_PERSONA_JSON,
        }),
      }),
      adkPath: "/ws",
    });
    const p = store.load();
    expect(p).toBeDefined();
    expect(p?.agentName).toBe("알파");
    expect(p?.userName).toBe("루크");
    expect(p?.honorific).toBe("마스터");
    expect(p?.speechStyle).toBe("formal");
    expect(p?.locale).toBe("ko"); // NAIA_LOCALE → locale
    expect(p?.systemPromptPrefix).toBe(ALPHA_PREFIX); // 내장 persona JSON 문자열에서 추출
  });

  it("load() → composePersonaPrompt 관통: 실 config 가 알파 prompt 를 만든다(SoT 한 바퀴)", () => {
    const store = makePersonaSourceStore({
      fs: memFs({
        [CONFIG]: JSON.stringify({
          agentName: "알파",
          userName: "루크",
          speechStyle: "formal",
          honorific: "마스터",
          NAIA_LOCALE: "ko",
          persona: ALPHA_PERSONA_JSON,
        }),
      }),
      adkPath: "/ws",
    });
    const out = composePersonaPrompt(store.load() ?? {});
    expect(out).toContain(ALPHA_PREFIX);
    expect(out).toContain("존댓말");
    expect(out).toContain("마스터");
    expect(out).not.toContain("[HAPPY]");
  });

  it("config.json 부재 → undefined(no-throw, 페르소나 기본 없음)", () => {
    const store = makePersonaSourceStore({ fs: memFs({}), adkPath: "/ws" });
    expect(store.load()).toBeUndefined();
  });

  it("config.json JSON 손상 → undefined(no-throw)", () => {
    const store = makePersonaSourceStore({ fs: memFs({ [CONFIG]: "{ not json" }), adkPath: "/ws" });
    expect(store.load()).toBeUndefined();
  });

  it("persona 필드 손상(JSON 아님) → personaText 폴백, 타 필드 정상 매핑(degrade)", () => {
    const store = makePersonaSourceStore({
      fs: memFs({
        [CONFIG]: JSON.stringify({ agentName: "알파", userName: "루크", NAIA_LOCALE: "ko", persona: "그냥 평문 페르소나" }),
      }),
      adkPath: "/ws",
    });
    const p = store.load();
    expect(p?.agentName).toBe("알파");
    expect(p?.systemPromptPrefix).toBeUndefined();
    expect(p?.personaText).toBe("그냥 평문 페르소나");
  });

  it("persona 부재 → systemPromptPrefix/personaText 모두 undefined, 타 필드만 매핑", () => {
    const store = makePersonaSourceStore({
      fs: memFs({ [CONFIG]: JSON.stringify({ agentName: "알파", userName: "루크" }) }),
      adkPath: "/ws",
    });
    const p = store.load();
    expect(p?.agentName).toBe("알파");
    expect(p?.userName).toBe("루크");
    expect(p?.systemPromptPrefix).toBeUndefined();
    expect(p?.personaText).toBeUndefined();
    // base 없으면 composePersonaPrompt 가 "" (페르소나 기본 없음)
    expect(composePersonaPrompt(p ?? {})).toBe("");
  });

  it("adkPath 빈값 → undefined", () => {
    const store = makePersonaSourceStore({ fs: memFs({ [CONFIG]: "{}" }), adkPath: "" });
    expect(store.load()).toBeUndefined();
  });

  it("trailing slash 정규화(/ws/ → /ws/naia-settings/config.json)", () => {
    const store = makePersonaSourceStore({
      fs: memFs({ [CONFIG]: JSON.stringify({ agentName: "알파", persona: ALPHA_PERSONA_JSON }) }),
      adkPath: "/ws/",
    });
    expect(store.load()?.agentName).toBe("알파");
  });
});

describe("#158 호칭 규칙", () => {
  const INSTRUCTION_A_NO_NAME =
    'Never address the user with any title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal". Speak directly without addressing them.';
  const INSTRUCTION_A_WITH_NAME =
    'Never address the user with any title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal". Apart from the occasional use of their name described above, speak directly without addressing them.';
  const INSTRUCTION_B =
    'Do not address the user with any other title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal"; use only the form given above.';
  const FREQUENCY_LINE =
    'Use this form only now and then: most replies should not contain it, and never use it in two consecutive replies.';

  function extractHonorificInstructionLine(prompt: string): string | undefined {
    return prompt
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          line.startsWith("Address the user as") ||
          line.includes("is a suffix that must follow a name"),
      );
  }

  it("ko+casual, 호칭 없음: 출력에 이름 없는 문장 A 가 있고 문장 B 는 없다", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion. Speak casually and warmly.",
      locale: "ko",
      speechStyle: "casual",
    });
    expect(out).toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_B);
  });

  it("en, 호칭 없음: 출력에 이름 없는 문장 A 가 있고 문장 B 는 없다", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "en",
    });
    expect(out).toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_B);
  });

  it("ko, 이름 '민수'·호칭 '님' 지정 (이름+님): 호칭 줄 바로 다음 줄이 빈도 줄과 문장 B, 문장 A 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ko",
      userName: "민수",
      honorific: "님",
    });
    const expectedNameLine =
      'The user\'s name is "민수". Use the name only now and then: most replies should not contain it, never use it in two consecutive replies, and do not start replies with it.';
    const expectedHonorificLine = 'Address the user as "님 민수" or "민수님" as appropriate for Korean.';
    expect(out).toContain(expectedNameLine);
    expect(extractHonorificInstructionLine(out)).toBe(expectedHonorificLine);
    expect(out).toContain(expectedHonorificLine);
    expect(out).toContain(`${expectedHonorificLine}\n${FREQUENCY_LINE}\n${INSTRUCTION_B}`);
    expect(out).not.toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("en, 호칭 '님' 지정 (이름 없음): 기존 호칭 줄이 없고, 이름 없는 문장 A 가 있으며, 문장 B 는 없다", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "en",
      honorific: "님",
    });
    expect(out).not.toContain('Address the user as "님');
    expect(out).toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_B);
  });

  it("locale 없음, 이름 '민수'·호칭 '님' 지정: 호칭 줄 바로 다음 줄이 빈도 줄과 문장 B, 문장 A 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      userName: "민수",
      honorific: "님",
    });
    const expectedNameLine =
      'The user\'s name is "민수". Use the name only now and then: most replies should not contain it, never use it in two consecutive replies, and do not start replies with it.';
    const expectedHonorificLine =
      'Address the user as "님 민수" or "민수님" as appropriate for the user\'s language.';
    expect(out).toContain(expectedNameLine);
    expect(out).toContain(expectedHonorificLine);
    expect(out).toContain(`${expectedHonorificLine}\n${FREQUENCY_LINE}\n${INSTRUCTION_B}`);
    expect(out).not.toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("이름만 있음: 이름 줄과 이름 있는 문장 A 가 함께 있고 문장 B 는 없다", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      userName: "민수",
      locale: "ko",
    });
    const expectedNameLine =
      'The user\'s name is "민수". Use the name only now and then: most replies should not contain it, never use it in two consecutive replies, and do not start replies with it.';
    expect(out).toContain(expectedNameLine);
    expect(out).toContain(INSTRUCTION_A_WITH_NAME);
    expect(out).not.toContain(INSTRUCTION_B);
    expect(out).not.toContain(INSTRUCTION_A_NO_NAME);
  });

  it("호칭만 있고 이름 없음(locale 'ko', 호칭 '님'): 접미사 문장과 이름 없는 문장 A 가 들어가고 'Address the user as'와 문장 B('use only the form given above') 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ko",
      honorific: "님",
    });
    const expectedSuffix =
      '"님" is a suffix that must follow a name, and the user\'s name is unknown, so never use "님" by itself. Do not address the user at all; speak directly without any title or nickname.';
    expect(extractHonorificInstructionLine(out)).toBe(expectedSuffix);
    expect(out).toContain(expectedSuffix);
    expect(out).toContain(`${expectedSuffix}\n${INSTRUCTION_A_NO_NAME}`);
    expect(out).toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain('"님 "');
    expect(out).not.toContain("Address the user as");
    expect(out).not.toContain(INSTRUCTION_B);
    expect(out).not.toContain("use only the form given above");
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("호칭만 있고 이름 없음(locale 'ko', 호칭 '씨'): 접미사 문장과 이름 없는 문장 A 가 들어가고 'Address the user as'와 문장 B 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ko",
      honorific: "씨",
    });
    const expectedSuffix =
      '"씨" is a suffix that must follow a name, and the user\'s name is unknown, so never use "씨" by itself. Do not address the user at all; speak directly without any title or nickname.';
    expect(extractHonorificInstructionLine(out)).toBe(expectedSuffix);
    expect(out).toContain(expectedSuffix);
    expect(out).toContain(`${expectedSuffix}\n${INSTRUCTION_A_NO_NAME}`);
    expect(out).toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain("Address the user as");
    expect(out).not.toContain(INSTRUCTION_B);
    expect(out).not.toContain("use only the form given above");
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("호칭만 있고 이름 없음(locale 'ko', 호칭 ' 님 ' 공백): trim 된 접미사 문장과 이름 없는 문장 A 가 들어가고 'Address the user as'와 문장 B 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ko",
      honorific: " 님 ",
    });
    const expectedSuffix =
      '"님" is a suffix that must follow a name, and the user\'s name is unknown, so never use "님" by itself. Do not address the user at all; speak directly without any title or nickname.';
    expect(extractHonorificInstructionLine(out)).toBe(expectedSuffix);
    expect(out).toContain(expectedSuffix);
    expect(out).toContain(`${expectedSuffix}\n${INSTRUCTION_A_NO_NAME}`);
    expect(out).toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain("Address the user as");
    expect(out).not.toContain(INSTRUCTION_B);
    expect(out).not.toContain("use only the form given above");
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("호칭만 있고 이름 없음(locale 'ko', 호칭 '오빠'): 독립 호칭 문장에 '오빠' 포함되고 문장 B 가 들어가며 문장 A 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ko",
      honorific: "오빠",
    });
    const expected =
      'Address the user as "오빠". Use it only now and then: most replies should not contain it, and never use it in two consecutive replies.';
    expect(extractHonorificInstructionLine(out)).toBe(expected);
    expect(out).toContain(expected);
    expect(out).toContain(`${expected}\n${INSTRUCTION_B}`);
    expect(out).toContain(INSTRUCTION_B);
    expect(out).not.toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("호칭만 있고 이름 없음(locale 'ja', 호칭 '先輩'): 독립 호칭 문장에 '先輩' 포함되고 문장 B 가 들어가며 문장 A 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ja",
      honorific: "先輩",
    });
    const expected =
      'Address the user as "先輩". Use it only now and then: most replies should not contain it, and never use it in two consecutive replies.';
    expect(extractHonorificInstructionLine(out)).toBe(expected);
    expect(out).toContain(expected);
    expect(out).toContain(`${expected}\n${INSTRUCTION_B}`);
    expect(out).toContain(INSTRUCTION_B);
    expect(out).not.toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });

  it("ja, 이름 '민수'·호칭 'さん': 호칭 줄 바로 다음 줄이 빈도 줄과 문장 B, 문장 A 없음", () => {
    const out = composePersonaPrompt({
      systemPromptPrefix: "You are an AI companion.",
      locale: "ja",
      userName: "민수",
      honorific: "さん",
    });
    const expectedNameLine =
      'The user\'s name is "민수". Use the name only now and then: most replies should not contain it, never use it in two consecutive replies, and do not start replies with it.';
    const expectedHonorificLine = 'Address the user as "さん 민수" or "민수さん" as appropriate for Japanese.';
    expect(out).toContain(expectedNameLine);
    expect(out).toContain(expectedHonorificLine);
    expect(out).toContain(`${expectedHonorificLine}\n${FREQUENCY_LINE}\n${INSTRUCTION_B}`);
    expect(out).not.toContain(INSTRUCTION_A_NO_NAME);
    expect(out).not.toContain(INSTRUCTION_A_WITH_NAME);
  });
});

