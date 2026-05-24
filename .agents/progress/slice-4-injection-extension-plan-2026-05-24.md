# Slice 4 — Host Injection / ADK Extension / i18n / Onboarding Wizard (2026-05-24)

**상태**: 4-A DONE (2026-05-24). 4-B~4-I 대기.
**선행 완료**: 3-XR-A~O (CLI 출시), 4-P1 (Provider Registry).

---

## 0. 아키텍처 원칙

1. **naia-agent = core** — 에이전트 뼈대 (내장 스킬, 훅, 시스템 프롬프트)
2. **naia-os = host** — 껍데기. UI 렌더링만. 런타임에 스킬/훅/프롬프트를 **주입**
3. **naia-adk = extension** — 외부 도메인 스킬/훅/프롬프트를 **확장**

**의존성 방향이 분류 기준** (로드 메커니즘이 아님):
- Core: host 의존성 0 (CLI/naia-os/어디서든 동작)
- Host injection: host 전용 기능 필요 (browser, audio, screen)
- ADK extension: 파일시스템에서 로드, 도메인 특화

---

## 1. 스킬 분류 (Round 1 리뷰 반영)

### Core (내장) — host 의존성 0, 항상 사용 가능

| 스킬 | 구현 위치 | 비고 |
|------|-----------|------|
| bash | packages/runtime/src/skills/bash.ts | 플랫폼 감지 필요 (Windows/Linux) |
| read_file, write_file, edit_file, list_files | packages/runtime/src/skills/file-ops.ts | --enable-file-ops |
| code | packages/runtime/src/skills/coding-tool.ts | CLI 연결 필요 |
| time | packages/runtime/src/skills/time.ts | **4-A DONE** 순수 Node, T0 |
| weather | packages/runtime/src/skills/weather.ts | **4-A DONE** HTTP (wttr.in, key 불필요), T0 |
| memo | packages/runtime/src/skills/memo.ts | **4-A DONE** node:fs, T1 |
| system-status | packages/runtime/src/skills/system-status.ts | **4-A DONE** node:os, T0 |
| diagnostics | packages/runtime/src/skills/diagnostics.ts | **DONE** SessionManager + ConfigManager 상태 노출, T0 |
| sessions | packages/runtime/src/skills/sessions.ts | **DONE** SessionManager 기반 세션 관리, T0 |
| config | packages/runtime/src/skills/config.ts | **DONE** ConfigManager 기반 설정 조회/변경, T1 |

### Host Injection — naia-os 전용, stdio proxy로 주입

| 스킬 | 의존성 | 주입 방식 |
|------|--------|-----------|
| browser | WebView2 / X11 | panel proxy stub (기존 PanelSkillsRequest 패턴) |
| panel | Tauri panel system | panel proxy stub |
| tts | 오디오 재생 시스템 | proxy round-trip |
| voicewake | 마이크 하드웨어 | proxy round-trip |
| youtube-bgm | 오디오 + 브라우저 | proxy round-trip |
| screen-capture | OS screen capture API | proxy round-trip |
| device | Tauri 디바이스 정보 | proxy round-trip |
| notify-* | webhook URL (naia-os 설정에서 획득) | proxy (webhook URL은 host에서만 알 수 있음) |
| cron | 지속성 타이머 인프라 | proxy round-trip |
| welcome | 아바타/UI 컨텍스트 | proxy round-trip |
| naia-discord | Discord bot 이벤트 루프 | proxy round-trip |
| agents | 서브에이전트 스폰 | proxy round-trip |
| approvals | 권한 승인 UI | proxy round-trip |
| skill-manager | 패널 설치 UI | proxy round-trip |
| botmadang | 외부 API + UI | proxy round-trip |
| channels | Discord 채널 관리 | proxy round-trip |

### ADK Extension — naia-adk에서 파일로 로드

| 스킬 | 비고 |
|------|------|
| doc-coauthoring | 문서 공동 작성 |
| review-pass | 다중 AI 리뷰 |
| read-doc | 문서 텍스트 추출 |
| email | SMTP 발송 |
| sms | SMS 발송 |
| document-generation | PDF 생성 |
| channel-management | 채널 관리 (spec-only) |
| service-management | 서비스 모니터링 (spec-only) |
| web-monitoring | 웹 모니터링 (spec-only) |

### Memory: 선택적 core (NOT 기본)

`memory`는 `@nextain/naia-memory` (SQLite) 의존성이 있어 **기본 core에서 제외**.
`--memory` 플래그로 opt-in 활성화 (기존 동작 유지). host나 ADK에서 의존성 주입 가능.

---

## 2. 주입 프로토콜 설계

### 기존 패턴 재사용

naia-os의 `PanelSkillsRequest`가 이미 동작하는 proxy stub 패턴.
이를 일반화:

```
Host → Agent: { kind: "skill_inject", skills: [...tool definitions] }
Agent: proxy stub 등록 → LLM이 tool 호출 → Agent → Host: { kind: "tool_call", ... }
Host: 실행 → Agent: { kind: "tool_result", ... }
```

### 성능 고려 (R1 반영)

- **proxy stub만 stdio 왕복** (panel, browser, tts 등 어쩔 수 없는 것들)
- **순수 Node 스킬은 core로 이관** → 직접 실행, 0 latency
- sub-100ms 응답이 필요한 스킬(time, weather, memo)은 **절대 proxy로 만들지 않음**

### 보안 (R1 반영)

- `system_prompt_inject`: capability-based 권한 필요
- `ALLOWED_KINDS` 화이트리스트 유지
- 주입된 스킬의 티어 검증 (T0-T3)

### 버전 관리 (R5 반영)

- skill descriptor에 `schemaVersion` 필드 추가
- 마이그레이션 시 하위 호환성 보장

---

## 3. 스킬 충돌 해결 (R4 반영)

### 우선순위 규칙

```
Host injection > ADK extension > Core (동일 이름 스킬)
```

- Host가 `weather`를 주입하고 ADK에도 `weather`가 있으면 → Host 주입 승리
- `SkillRegistry.register()`를 덮어쓰 허용으로 변경 (throw 대신)
- 로드 순서: Core 먼저 → ADK extension → Host injection (나중이 이김)

---

## 4. 시스템 프롬프트 빌더 (R5 반영)

### 현행 문제

`buildToolStatusPrompt()`가 100줄 if/else 문자열 결합.
다중 소스(core + host + ADK) 추가 전 구조화 필요.

### 설계

```typescript
interface PromptFragment {
  source: "core" | "host" | "adk";
  priority: number;      // 낮을수록 먼저
  section: "identity" | "tools" | "persona" | "domain" | "safety";
  content: string;
}

class SystemPromptBuilder {
  add(fragment: PromptFragment): void;
  build(): string;  // priority → section 순으로 정렬 결합
}
```

---

## 5. Hook 시스템 (R3 반영)

### 복잡도 인정

agent.ts 루프에 확장 포인트가 없음. 훅 인프라는 별도 슬라이스로 분리.

### 설계

```typescript
type HookEvent = "turn-start" | "turn-end" | "error" | "tool-call" | "tool-result";
type HookHandler = (ctx: HookContext) => void | Promise<void>;

interface HookRegistration {
  source: "core" | "host" | "adk";
  event: HookEvent;
  handler: HookHandler;
  priority?: number;
}

class HookDispatcher {
  register(reg: HookRegistration): void;
  async emit(event: HookEvent, ctx: HookContext): Promise<void>;
}
```

- **비동기**: 모든 훅은 async, 순차 실행 (parallel 아님)
- **실패 처리**: 훅 실패 시 warn 로그, turn 중단 안 함 (fire-and-forget 원칙)
- **우선순위**: 낮을수록 먼저, 같으면 등록 순

---

## 6. i18n (R2 반영 — 독립 시스템)

### 원칙

- **naia-agent i18n과 naia-os i18n은 완전 분리**
- 공유하는 것: 언어 감지 로직 (LC_ALL / navigator.language) + locale 값뿐
- CLI 문자열 세트와 React UI 문자열 세트는 disjoint

### 구현

```typescript
// packages/runtime/src/i18n/index.ts
type Locale = "ko" | "en" | "ja" | "zh" | "fr" | "de" | "ru" | "es" | "ar" | "hi" | "bn" | "pt" | "id" | "vi";
const translations: Record<TranslationKey, Record<Locale, string>> = { ... };

function getLocale(): Locale;  // config.json → LC_ALL → "en"
function t(key: TranslationKey): string;
```

- CLI 출력용 문자열만 포함 (시스템 프롬프트 템플릿, 에러 메시지, 위자드 UI 텍스트)
- 14개 언어 모두 지원하되, 초기엔 ko/en만 완전 번역, 나머지는 en fallback

---

## 7. Slice 순서 (R6 반영 — 재배치)

```
4-A: 순수 Node 스킬 이관 (time, weather, memo, diagnostics, system-status, sessions, config)
     naia-os agent/src/skills/built-in/ → naia-agent packages/runtime/src/skills/
     의존: 없음. 순수 코드 이동.

4-B: 시스템 프롬프트 빌더 리팩토링 **DONE**
     buildToolStatusPrompt() → SystemPromptBuilder (PromptFragment 기반)
     의존: 없음. 독립 리팩토링.

4-C: 스킬 충돌 해결 + 우선순위 **DONE**
     SkillRegistry.register() 덮어쓰 허용, core→adk→host 순서 보장
     결정 기준: CompositeToolExecutor를 SkillRegistry로 대체 (unified "last wins" 단일 경로)
     의존: 없음.

4-D: 스킬 주입 프로토콜 (기존 PanelSkillsRequest 일반화) **DONE**
     skill_inject / skill_revoke 메시지 추가
     schemaVersion 필드
     의존: 4-A (이관 완료 후 어떤 스킬을 proxy로 만들지 명확해짐)

4-E: Hook dispatch 인프라
     HookDispatcher + agent.ts 확장 포인트 추가
     의존: 없음 (core 변경이지만 독립)

4-F: i18n (독립, naia-os와 분리)
     packages/runtime/src/i18n/ 생성
     ko/en 완전 번역, 나머지 en fallback
     config.json locale 필드
     의존: 없음

4-G: 온보딩 위자드
     language → naia-key → main LLM → embedding → persona → start → done
     의존: 4-F (i18n)

4-H: ADK 훅/프롬프트 확장
     --skills-dir에서 hooks.yaml + prompt.md 로드
     의존: 4-B (프롬프트 빌더), 4-E (hook dispatcher)

4-I: 내장 스킬 정리 + code 스킬 CLI 연결
     code 스킬 연결, 멀티모달 output (CLI: 파일 저장)
     의존: 4-D (주입 프로토콜 완성 후 최종 정리)
```

---

## 8. 테스트 전략

| 슬라이스 | 단위 테스트 | 통합 테스트 |
|---------|------------|------------|
| 4-A | 이관 스킬 각각 동작 | bin smoke (time, weather) |
| 4-B | PromptFragment 정렬, 결합 | 기존 시스템 프롬프트 회귀 |
| 4-C | 충돌 시 host > adk > core | — |
| 4-D | 주입/취소, schema 버전 | stdio mock 프로토콜 |
| 4-E | HookDispatcher 등록/발화/실패 | agent.ts 훅 발화 지점 |
| 4-F | t() 함수, locale 감지, fallback | — |
| 4-G | 위자드 스텝 순서 | bin spawn |
| 4-H | hooks.yaml + prompt.md 파싱 | --skills-dir 전체 로드 |
| 4-I | code 스킬, 파일 output | bin smoke |

---

## 9. 크로스리뷰 이력

### Round 1 (2026-05-24)

| # | 지적 | 심각도 | 반영 |
|---|------|--------|------|
| R1 | 모든 스킬 stdio proxy → latency 회귀 | CRITICAL | 순수 Node 스킬은 core 이관, proxy는 host 전용만 |
| R2 | i18n dict 공유 → 커플링 트랩 | HIGH | 완전 분리, 언어 감지만 공유 |
| R3 | Hook 시스템 복잡도 과소평가 | HIGH | 별도 슬라이스(4-E)로 분리, 설계 명시 |
| R4 | 스킬 충돌 해결 없음 | MEDIUM | 우선순위 규칙 (host > adk > core) |
| R5 | 시스템 프롬프트 합성 엉망 | MEDIUM | PromptFragment 빌더로 리팩토링 (4-B) |
| R6 | 마이그레이션 순서 잘못됨 | HIGH | i18n/wizard를 뒤로, 스킬 이관/리팩토링을 앞으로 |

### Round 2 (2026-05-24)

| # | 지적 | 심각도 | 반영 |
|---|------|--------|------|
| R2-1 | CompositeToolExecutor "first wins" vs plan "last wins" 충돌 | MEDIUM | 4-C에 명시: CompositeToolExecutor 대체 또는 통일 |
| R2-2 | weather 스킬 API key 출처 불명 | LOW | 이관 시 검증, 필요시 "core with opt-in host config"로 재분류 |
| R2-3 | code 스킬 delta 불명확 | LOW | 4-I에 명시: coding-tool.ts CLI 연결만 (구현은 이미 있음) |
| R2-4 | 주입 프로토콜 에러 복구 없음 | LOW | 4-D에 추가: proxy timeout 30s, revoke 시 in-flight 완료 허용, inject 멱등성 |
| R2-5 | memo 스킬 MemoryProvider 의존성 | LOW | graceful degradation 명시 (MemoryProvider 없으면 "memory unavailable") |

### Round 3 (2026-05-24)

| # | 지적 | 심각도 | 반영 |
|---|------|--------|------|
| R3-1 | R2-1 수정안에 "또는" 두 옵션 미해결 | LOW | 결정: CompositeToolExecutor → SkillRegistry 대체 (unified last-wins 단일 경로) |

**최종 판정: CONDITIONALLY CLEAN → CLEAN (R3-1 해결 완료)**
