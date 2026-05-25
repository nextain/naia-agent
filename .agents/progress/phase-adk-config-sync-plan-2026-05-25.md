# Phase: naia-adk 설정 동기화 + 대화 동기화 (v2 — 전수 리뷰 기반)

Date: 2026-05-25
Status: DONE (2-pass cross-review clean, 0 CRITICAL/0 MAJOR)
Depends: Slice 4 (완료), Slice 5 (완료), 온보딩 뼈대 (완료, commit `2142c20`)

---

## 1. 아키텍처 원칙

### 1.1 NAIA_ADK_PATH = 모든 것의 루트

```
{NAIA_ADK_PATH}/                           ← 예: ~/naia-adk, D:\alpha-adk
├── .agents/                                ← AI 에이전트 영역
│   ├── skills/                             ← 확장 스킬 (naia-agent가 자동 로드)
│   ├── hooks/                              ← 훅
│   ├── context/                            ← 컨텍스트 (agents-rules.json 등)
│   └── workflows/                          ← 워크플로우
├── .users/                                 ← 사용자 미러 (KO 기본 + 언어별)
│   ├── skills/
│   └── en/
├── naia-settings/                          ← 설정 SoT
│   ├── config.json                         ← provider, model, persona, agents
│   ├── credentials                         ← 키 이름 매니페스트
│   ├── llm.json                            ← LLM 역할
│   ├── .keys/                              ← 암호화 API 키 (DPAPI/Keychain)
│   ├── sessions/                           ← 대화 세션 + 핸드오프
│   ├── vrm-files/                          ← VRM (naia-os만)
│   └── background/                         ← 배경 (naia-os만)
├── skills/                                 ← 도메인 확장 스킬
└── docs/
```

### 1.2 설정 발견 순서 (naia-agent standalone)

```
1. env NAIA_ADK_PATH 있음?
   → YES: {NAIA_ADK_PATH}/naia-settings/config.json

2. ~/.naia-agent/config.json → adkPath 필드 있음?
   → YES: {adkPath}/naia-settings/config.json

3. ~/.naia/adk-path 파일 있음? (naia-os 캐시)
   → YES: 읽은 경로/naia-settings/config.json

4. ~/naia-adk/ (기본값)
```

### 1.3 부트스트랩 파일

`~/.naia-agent/config.json` — naia-agent 자체 부트스트랩 정보만:
```json
{
  "adkPath": "C:/Users/LukeYang/naia-adk",
  "version": "0.0.1"
}
```

### 1.4 실행 모드

**Standalone**: 파일 기반 (ADK에서 읽기)
**Hosted (naia-os)**: 주입 기반 (naia-os → stdio IPC)

---

## 2. 전수 리뷰 결과 (함수/변수/필드 단위)

### 2.1 CRITICAL 버그 (P0)

| ID | 문제 | 파일 | 원인 |
|----|------|------|------|
| D-01 | Claude Code 분기가 buildLLMClient() 밖에 있음 | naia-agent bin:676-691 | 코드가 runDirect()의 handoff 블록 안에 잘못 삽입. `env`, `overrideModel` 변수가 스코프에 없음 → `NAIA_MAIN_PROVIDER=claude-code` 시 항상 실패 |
| D-02 | `runStdio()`에서 `args` undefined | naia-agent bin:1336 | `buildLLMClient(args.model)` — `args`는 `main()` 지역변수. stdio 모드에서 `chat_request`마다 crash |

### 2.2 MAJOR 버그 (P1)

| ID | 문제 | 파일 | 원인 |
|----|------|------|------|
| D-03 | `onboardingComplete`가 config.json에서 제거됨 | naia-os adk-store.ts:134 | `stripForAgent()`가 UI_ONLY로 분류. naia-agent는 이 값을 확인하는데 naia-os에서 사라짐 |
| D-04 | persona 필드명 NAIA_ prefix 불일치 | naia-agent onboarding ↔ naia-os | naia-agent는 `NAIA_AGENT_NAME`/`NAIA_USER_NAME`/`NAIA_SPEECH_STYLE`로 읽고 씀. naia-os `buildNaiaConfigEnv()`는 이 키를 생산하지 않음 → standalone에서 persona 값 누락 |
| D-05 | Memory LLM provider env var 경로 없음 | naia-os config | `buildNaiaConfigEnv()`가 `NAIA_LLM_PROVIDER` 미생산 |

### 2.3 MODERATE 버그 (P2)

| ID | 문제 | 파일 | 원인 |
|----|------|------|------|
| D-07 | runStdio()가 매 요청마다 새 Agent 생성 | naia-agent bin:1336-1405 | LLM 클라이언트/Agent 재사용 없음. `enableTools`, `disabledSkills`, `routeViaGateway` 무시 |
| D-08 | `memoryEmbeddingApiKey` IPC 경로 없음 | naia-os → naia-agent | 키체인에는 저장되나 env/IPC로 전달 안 됨 |

### 2.4 MINOR (P3)

| ID | 문제 | 파일 |
|----|------|------|
| D-09 | `OLLAMA_HOST`/`VLLM_HOST` env var 사용 안 됨 | naia-agent (dead vars) |
| D-10 | stdio 모드가 tts_request, tool_request, skill_list 등 핸들러 없음 | naia-agent runStdio() |
| D-11 | 게이트웨이 URL PROD vs DEV 불일치 | naia-os vs naia-agent |

### 2.5 Missing Features (naia-agent에 없는 기능 25개)

VRM/배경, TTS/STT/음성, 게이트웨이 동기화, 스킬 토글, 툴 허용 목록, 시크릿 마이그레이션, BGM, 패널 시스템, 감사 로깅, 브라우저 OAuth, 로케일 시스템 프롬프트, 디바이스 서명, 승인 브로커, 비용 추적, 사고 출력, Discord 이벤트, 메모리 동기화, 설정 변경 이벤트, 다중 모델 캡태그 — 이 Phase에서는 다루지 않음 (별도 Phase).

---

## 3. 작업 항목 (우선순위순)

### Phase 1: CRITICAL 버그 수정 (naia-agent만)

| ID | 작업 | 상세 |
|----|------|------|
| W1 | D-01: Claude Code 분기를 buildLLMClient()로 이동 | `naia-agent.ts` 676-691행을 464-466행 사이로 이동. `env`, `overrideModel` 스코프 확인 |
| W2 | D-02: runStdio()의 `args.model` 수정 | `buildLLMClient(args.model)` → `buildLLMClient(undefined)` 또는 runStdio에 args 파라미터 추가 |
| W3 | D-07: runStdio() LLM/Agent 캐싱 | 요청마다 Agent 재생성 대신 캐시된 Agent 재사용. `enableTools`/`disabledSkills` 반영 |

### Phase 2: 설정 인프라 (naia-agent)

| ID | 작업 | 상세 |
|----|------|------|
| W4 | 설정 발견 순서 4계층 구현 | NAIA_ADK_PATH → ~/.naia-agent/config.json → ~/.naia/adk-path → ~/naia-adk/ |
| W5 | ~/.naia-agent/config.json 부트스트랩 | adkPath + version 필드. 온보딩 완료 시 저장 |
| W6 | 확장 스킬 자동 로드 | `{adkPath}/.agents/skills/` + `{adkPath}/skills/` 자동 스캔 |
| W7 | /setup env 리로드 수정 | 기존 provider env 키 삭제 후 재로드 |
| W8 | config.json 필드명 통일 | NAIA_* prefix ↔ camelCase 양방향 읽기 지원 |

### Phase 3: naia-os 설정 동기화

| ID | 작업 | 상세 |
|----|------|------|
| W9 | D-03: onboardingComplete 보존 | `UI_ONLY_CONFIG_KEYS`에서 제거 |
| W10 | D-04: persona 필드명 통일 | `buildNaiaConfigEnv()`에서 `NAIA_AGENT_NAME`/`NAIA_USER_NAME`/`NAIA_SPEECH_STYLE` 키 추가 |
| W11 | D-05: Memory LLM provider env 추가 | `buildNaiaConfigEnv()`에 `NAIA_LLM_PROVIDER` 등 추가 |
| W12 | B1: Rust에서 NAIA_ADK_PATH 전달 | spawn 시 env 추가 |
| W13 | B4: 온보딩 시 naiaKey 키체인 저장 | writeAgentKey() 호출 추가 |
| W14 | D-11: 게이트웨이 URL 통일 | 공통 상수 또는 config에서 읽기 |

### Phase 4: 세션 동기화

| ID | 작업 | 상세 |
|----|------|------|
| W15 | 세션 저장 | `{adkPath}/naia-settings/sessions/{id}.json` |
| W16 | /resume 명령어 | 이전 세션 핸드오프 블롭 로드 |
| W17 | 세션 목록 (/sessions) | 저장된 세션 나열 |

### Phase 5: stdio 모드 보강

| ID | 작업 | 상세 |
|----|------|------|
| W18 | D-10: tts_request 핸들러 | |
| W19 | D-10: tool_request 핸들러 | |
| W20 | D-10: skill_list 핸들러 | |
| W21 | D-10: approval_response 핸들러 | |
| W22 | D-08: embedding API key IPC 경로 | creds_update에 추가 |

---

## 4. 의존 관계

```
W1 (Claude Code 수정) — 독립
W2 (runStdio args) — 독립
W3 (runStdio 캐싱) — W2 이후
W4 (발견 순서) — 독립
W5 (부트스트랩) — W4 이후
W6 (스킬 자동 로드) — W4 이후
W7 (env 리로드) — W4 이후
W8 (필드명 통일) — W4 이후
W9-W14 (naia-os) — 병렬 진행 가능
W15-W17 (세션) — W4, W7 이후
W18-W22 (stdio 보강) — W2, W3 이후
```

## 5. 완료 기준

1. `pnpm naia-agent` → ADK에서 설정 + 스킬 자동 로드 → 대화 가능 ✅
2. `NAIA_MAIN_PROVIDER=claude-code` → Claude Code 구독으로 대화 가능 ✅
3. naia-os → naia-agent stdio → IPC로 설정 주입 → 대화 가능 ✅
4. naia-os에서 설정 변경 → config.json 업데이트 → naia-agent standalone에서 동일 설정 ✅
5. `/setup` 후 env 리로드 → 새 프로바이더로 대화 전환 ✅
6. 세션 저장/복원 동작 ✅
7. 전체 테스트 통과 ✅ (228 passed, 0 failed)

## 6. 완료 이력

| Phase | 커밋 | 내용 |
|-------|------|------|
| Phase 1 (CRITICAL) | `f3bf9b9` | D-01 Claude Code 분기 이동, D-02 runStdio args 수정, D-07 LLM/Memory 캐싱 |
| Phase 2 (설정 인프라) | `5ac16ad` | W4-W8 resolveAdkPath, 부트스트랩, 자동 스킬, env 리로드, 필드명 통일 |
| Phase 3 (naia-os 동기화) | `7741f46` | W9-W13 onboardingComplete 보존, persona/memory LLM 필드, NAIA_ADK_PATH 전달 |
| Phase 4 (세션 동기화) | `f417d32` | W15-W17 세션 저장, /resume, /sessions |
| Phase 5 (stdio 보강) | `d44f78b` | W18-W22 tts/tool/skill/approval 핸들러, embedding 키 매핑 |
| W14 + 시나리오 + 리뷰 | `1b18547` | 게이트웨이 PROD 통일, 16 시나리오 테스트, vertex null-check 수정 |

2-pass cross-review: 0 CRITICAL, 0 MAJOR, 4 MINOR (all accepted).

## 7. 통계

| 항목 | 수 |
|------|-----|
| env vars (naia-agent) | 38 |
| config 필드 비교 | 30+ |
| 함수 비교 | 25+ |
| CRITICAL 버그 | 2 |
| MAJOR 버그 | 3 |
| MODERATE 버그 | 2 |
| MINOR | 3 |
| 누락 기능 | 25 |
| 작업 항목 | 22 |
