// 로그 시크릿 마스킹 계약테스트 — redactSecrets 가 알려진 키/토큰을 [REDACTED] 치환하고,
// DiagnosticLog sink(makeStderrDiagnostic)가 write 직전 마스킹을 적용해 평문 자격증명이 stderr 로 새지 않음을 잠근다.
// 재감사 2026-06-23: 구 redactString(observability) 컷오버 누락 → 이식(보안). contract=docs/logging.md.
import { describe, it, expect } from "vitest";
import { redactSecrets } from "../main/adapters/redact.js";
import { makeStderrDiagnostic } from "../main/adapters/diagnostic.js";

const SECRETS: Record<string, string> = {
  "sk-ant": "sk-ant-api03-AbCdEf0123456789_-XyZ",
  "sk-openai": "sk-AbCdEf0123456789AbCdEf01",
  "google": "AIzaSyA0123456789abcdefABCDEF_-x",
  "github-pat": "github_pat_11ABCDEFG0123456789",
  "github-ghp": "ghp_AbCd0123456789AbCd0123",
  "slack": "xoxb-1234567890-ABCDEFabcdef",
  "aws": "AKIAIOSFODNN7EXAMPLE",
  "naia-gw": "gw-AbCdEf0123456789",
  "jwt": "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4",
};

describe("redactSecrets — 알려진 키/토큰 마스킹", () => {
  for (const [label, secret] of Object.entries(SECRETS)) {
    it(`${label} 토큰을 [REDACTED] 로 치환하고 원문 시크릿을 남기지 않는다`, () => {
      const out = redactSecrets(`apiKey=${secret} 로 호출`);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain(secret);
    });
  }

  it("시크릿이 없는 텍스트는 무손실(원문 그대로)", () => {
    const plain = "provider=ollama model=gemma4 turns=3 ok=true";
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("non-string 입력도 throw 하지 않고 String() 처리(로깅 never-throws)", () => {
    expect(redactSecrets(undefined as unknown as string)).toBe("undefined");
    expect(redactSecrets({ a: 1 } as unknown as string)).toContain("object");
  });

  it("한 줄에 여러 시크릿이 있어도 모두 마스킹", () => {
    const out = redactSecrets(`a=${SECRETS["sk-ant"]} b=${SECRETS["naia-gw"]}`);
    expect(out).not.toContain(SECRETS["sk-ant"]!);
    expect(out).not.toContain(SECRETS["naia-gw"]!);
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  // 적대리뷰 2026-06-23(codex): prefix 없는 시크릿 = 키-이름 문맥(=/:)으로 값 통째 마스킹.
  it("무prefix 시크릿을 키-이름 문맥으로 마스킹(apiKey/password/secret, =·: 모두)", () => {
    for (const line of [
      "apiKey=plainNoPrefix123456",
      "api_key: 'quotedSecretValue!'",
      "password=hunter2dontleak",
      "client_secret: abcDEF.ghi/jkl+mno=", // 특수문자 포함 — 값 통째(codex #1 suffix 노출 방지)
    ]) {
      const out = redactSecrets(line);
      expect(out, line).toContain("[REDACTED]");
      // 키 이름은 보존되되 값 토큰은 사라짐
      for (const leak of ["plainNoPrefix123456", "quotedSecretValue", "hunter2dontleak", "abcDEF.ghi/jkl+mno"]) {
        expect(out).not.toContain(leak);
      }
    }
  });

  it("AWS secret access key(무prefix, /+= 포함)를 키-이름 문맥으로 마스킹(codex #3)", () => {
    const out = redactSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("wJalrXUtnFEMI");
    expect(out).not.toContain("bPxRfiCYEXAMPLEKEY");
  });

  it("Authorization: Bearer <token> 의 토큰 마스킹(codex #4)", () => {
    const out = redactSecrets("Authorization: Bearer abc123.def456-ghi/jkl=");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc123.def456");
  });

  it("Slack xapp- app-level 토큰 마스킹(codex #2)", () => {
    const out = redactSecrets("slackApp=xapp-1-A0123-456789-abcdef");
    expect(out).not.toContain("xapp-1-A0123-456789-abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("오탐 가드: 할당(=/:) 아닌 prose 는 안 건드림(password reset 의 reset 보존)", () => {
    const out = redactSecrets("사용자가 password reset 링크를 요청함, token 갱신 완료");
    expect(out).toBe("사용자가 password reset 링크를 요청함, token 갱신 완료");
  });

  it("escaped-quote 우회 차단: JSON 로그 값 통째 마스킹(codex R2#1)", () => {
    const out = redactSecrets('apiKey="abc\\"DEFSECRETSUFFIX"');
    expect(out).not.toContain("DEFSECRETSUFFIX"); // suffix 누출 0
    expect(out).toContain("[REDACTED]");
  });

  it("과마스킹 가드: 비-시크릿 token 류 키는 보존(codex R2#2)", () => {
    // bare token/secret 제외 + trivial 값 가드 → 정상 로그 파괴 안 함
    for (const line of [
      "next_token=cursor123ABC",
      "page_token=abcDEF456",
      "cancellationToken: cancelled",
      "secret: false",
      "apikey: null",
      "count=42",
    ]) {
      expect(redactSecrets(line), line).toBe(line); // 변형 없음
    }
  });

  it("그래도 진짜 시크릿 키는 마스킹(access_token/client_secret 보존 회귀)", () => {
    expect(redactSecrets("access_token=realSecretValue123")).toContain("[REDACTED]");
    expect(redactSecrets("access_token=realSecretValue123")).not.toContain("realSecretValue123");
    expect(redactSecrets("client_secret: 'shh-do-not-leak-xyz'")).not.toContain("shh-do-not-leak-xyz");
  });

  it("credential 토큰명 확장 마스킹(codex R6): refresh/session/id token (pagination next/page 는 보존)", () => {
    for (const [line, leak] of [
      ["refresh_token=rt_abc123456789secret", "rt_abc123456789secret"],
      ['{"session_token":"st_xyz987654321"}', "st_xyz987654321"],
      ["id_token: idt_qwerty123456", "idt_qwerty123456"],
    ] as const) {
      const out = redactSecrets(line);
      expect(out, line).toContain("[REDACTED]");
      expect(out, line).not.toContain(leak);
    }
    // pagination 토큰은 여전히 보존(과마스킹 아님)
    expect(redactSecrets("next_token=cursor123ABC")).toBe("next_token=cursor123ABC");
    expect(redactSecrets("page_token=pageABC456")).toBe("page_token=pageABC456");
  });

  it("JSON quoted key 우회 차단(codex R3): \"access_token\":\"...\" 마스킹", () => {
    const out = redactSecrets('{"access_token":"abc123456789secret","user":"luke"}');
    expect(out).not.toContain("abc123456789secret"); // 값 누출 0
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("luke"); // 비-시크릿 필드 보존
  });

  it("구조화 JSON 로그 유효성 보존(codex R4): 따옴표 wrapper 유지 → valid JSON", () => {
    const out = redactSecrets('{"access_token":"abc123456789secret","user":"luke"}');
    // 마스킹 후에도 파싱 가능한 JSON(소비자/파서 무손상)
    const parsed = JSON.parse(out);
    expect(parsed.access_token).toBe("[REDACTED]");
    expect(parsed.user).toBe("luke");
  });

  it("quoted 숫자 문자열 credential 도 마스킹(codex R5): \"password\":\"123456\"", () => {
    const out = redactSecrets('{"password":"123456789","count":42}');
    expect(out).not.toContain("123456789"); // quoted 숫자 시크릿 누출 0
    const parsed = JSON.parse(out);
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.count).toBe(42); // unquoted 숫자(비-시크릿)는 보존
  });
});

describe("makeStderrDiagnostic — write 직전 시크릿 마스킹(통합)", () => {
  it("log() message/ctx 에 섞인 시크릿이 출력 라인에서 마스킹된다", () => {
    const lines: string[] = [];
    const diag = makeStderrDiagnostic({ write: (l) => lines.push(l), now: () => "T" });
    diag.log("provider 호출 실패", { authHeader: `Bearer ${SECRETS["sk-ant"]}`, naiaKey: SECRETS["naia-gw"] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRETS["sk-ant"]!);
    expect(lines[0]).not.toContain(SECRETS["naia-gw"]!);
    expect(lines[0]).toContain("[REDACTED]");
    // 비-시크릿 컨텍스트는 보존(메시지 가독성)
    expect(lines[0]).toContain("provider 호출 실패");
  });

  it("debug() 도 동일하게 마스킹(debug 모드 on)", () => {
    const lines: string[] = [];
    const diag = makeStderrDiagnostic({ write: (l) => lines.push(l), debug: true, now: () => "T" });
    diag.debug?.("ingress route", { token: SECRETS["jwt"] });
    expect(lines[0]).not.toContain(SECRETS["jwt"]!);
    expect(lines[0]).toContain("[REDACTED]");
  });
});
