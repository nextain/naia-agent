// adapters/persona-source-store — PersonaSourcePort 구현: 워크스페이스 페르소나 SoT 읽기.
//
// 정본(루크, user-confirmed): 페르소나 SoT = `<adkPath>/naia-settings/config.json` (naia-os 가 읽고 **쓰는**
// 동일 파일 → ghost-edit split 없음). 별도 페르소나 소스 신설 금지. config 의 관련 필드:
//   agentName, userName, speechStyle, honorific, NAIA_LOCALE,
//   persona (JSON **문자열** → 파싱 시 systemPromptPrefix/personaText 추출)
//
// ⚠️ 코어 순수 유지 — node:fs 직접 import 안 함. FsLike 주입(entry 가 node:fs 제공, 테스트는 fake).
//    (file-memo-store / naia-settings-store 의 fs 주입 패턴 동형.)
import type { PersonaSourcePort } from "../ports/uc1.js";
import type { PersonaProfile } from "../domain/persona.js";

/** config.json 읽기용 최소 fs(naia-settings-store SettingsFsRead 동형). entry 가 node:fs 주입, 테스트는 fake. */
export interface PersonaFsRead {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
}

/** unknown 값에서 비공백 string 만 추출(그 외=undefined). 손상 입력 방어. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * `<adkPath>/naia-settings/config.json` → PersonaProfile 매핑하는 PersonaSourcePort.
 * - config.json 부재/JSON 손상 = undefined 반환(no-throw, 페르소나 기본 없음).
 * - config.persona(JSON 문자열) 파싱 실패/부재 = systemPromptPrefix 생략 + personaText 폴백(원문이 객체가 아닌
 *   순수 문자열이면 그것을 personaText 로). 필드 누락은 모두 undefined 로 degrade(throw 금지).
 * - config.NAIA_LOCALE → profile.locale.
 */
export function makePersonaSourceStore(deps: { fs: PersonaFsRead; adkPath: string }): PersonaSourcePort {
  const { fs, adkPath } = deps;
  return {
    load(): PersonaProfile | undefined {
      if (!adkPath) return undefined;
      const file = `${adkPath.replace(/[\\/]+$/, "")}/naia-settings/config.json`;
      let cfg: Record<string, unknown>;
      try {
        if (!fs.existsSync(file)) return undefined;
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        cfg = parsed as Record<string, unknown>;
      } catch {
        return undefined; // 파일 손상/읽기 실패 = no-throw degrade
      }

      // persona 필드: JSON **문자열** 우선 파싱(객체면 그대로). 파싱 실패 시 원문 string 을 personaText 폴백.
      let systemPromptPrefix: string | undefined;
      let personaText: string | undefined;
      const personaRaw = cfg["persona"];
      if (typeof personaRaw === "string" && personaRaw.length > 0) {
        try {
          const pp: unknown = JSON.parse(personaRaw);
          if (pp && typeof pp === "object" && !Array.isArray(pp)) {
            systemPromptPrefix = str((pp as Record<string, unknown>)["systemPromptPrefix"]);
          }
        } catch {
          // persona 가 JSON 이 아닌 순수 텍스트 → personaText 폴백
          personaText = personaRaw;
        }
        // persona 가 JSON 객체였지만 systemPromptPrefix 가 없으면 원문 전체를 personaText 로(degrade base).
        if (!systemPromptPrefix && personaText === undefined) personaText = personaRaw;
      } else if (personaRaw && typeof personaRaw === "object" && !Array.isArray(personaRaw)) {
        // persona 가 이미 객체로 저장된 경우(드물지만 관용 허용)
        systemPromptPrefix = str((personaRaw as Record<string, unknown>)["systemPromptPrefix"]);
      }

      const profile: PersonaProfile = {
        ...(str(cfg["agentName"]) ? { agentName: str(cfg["agentName"])! } : {}),
        ...(str(cfg["userName"]) ? { userName: str(cfg["userName"])! } : {}),
        ...(str(cfg["honorific"]) ? { honorific: str(cfg["honorific"])! } : {}),
        ...(str(cfg["speechStyle"]) ? { speechStyle: str(cfg["speechStyle"])! } : {}),
        ...(str(cfg["NAIA_LOCALE"]) ? { locale: str(cfg["NAIA_LOCALE"])! } : {}),
        ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
        ...(personaText ? { personaText } : {}),
      };
      return profile;
    },
  };
}
