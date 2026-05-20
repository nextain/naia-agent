# 통합 시나리오 설계 — naia-agent 뼈대 × ADK 생태계

**상태**: FINAL v3 — GLM cross-review 2 라운드 (v1=REVISE → v2=REVISE) 후 micro-adjust 흡수. 구현 진입.
**일자**: 2026-05-20
**작성자**: Claude (Opus 4.7)
**Trigger**: Task #3 마무리 후 사용자 14개 메시지 종합 — 단위 테스트(`bin-user-scenarios.test.ts` 22+2)는 끝났고, **시나리오 기반 통합 테스트 + LLM-as-judge** + ADK 생태계 전 영역 커버가 필요.

---

## 1. Mental model

```
                  ┌────────────────────────────────────────┐
                  │           naia-agent (뼈대)            │
                  │ Agent loop · stripRecallResidue · safe │
                  │ Turn · provider-resolution · tool-loop │
                  └───────────────┬────────────────────────┘
                                  │ FileSkillLoader · SkillToolExecutor
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
   naia-adk skills/        business-adk skills/      onmam-adk skills/
   (20 generic skills)     (10 team/biz subset)      (11 + wp-archive)
        │                         │                         │
        └─────────────────────────┴─────────────────────────┘
                                  │
                          host (naia-os)
                          - 페르소나 주입 (ChatPanel)
                          - OnboardingWizard
                          - SettingsTab → llm.json
                                  │
                          deploy target
                          - 로컬 (luke PC, 24G)
                          - onmam-dev GCE
                          - naia-model-infra tier (8/24/48G)
```

핵심 원칙: **naia-agent는 ADK skill을 import**, **ADK는 naia-agent를 import 안 함**. 즉 모든 시나리오는 "ADK 생태계 자원이 있다고 가정했을 때 naia-agent가 그것을 활용·결합할 수 있는가" 검증.

---

## 2. 시나리오 그룹

### Group A. 24G 라이브 — gemma4:31b 실측 (deferred 해소)

기존 22-시나리오 harness의 LLM-live(S6/S7/S8)는 모두 8G e4b 였음. 24G 같은 경로로 재실행. thinking-mode 보강 적용.

| ID | 시나리오 | 평가 |
|---|---|---|
| A1 | gemma4:31b "한 문장 인사" (Answer-directly 시스템 + `max_tokens≥300`) | 텍스트 동기 + judge "인사 1문장인가?" |
| A2 | gemma4:31b chat smoke — naia-agent 가 직접 호출 (`--no-tools`) | exit0 + non-empty content + judge "응답이 자연스러운가?" |
| A3 | gemma4:31b persistent memory — 1차 fact 저장 → 2차 새 process 회상 | SQLite 메커니즘 + judge "정확히 회상했는가?" |
| A4 | gemma4:31b 한국어 출력 직접성 | judge "출력이 한국어이고 reasoning 마커 누출 0?" |
| A5 | gemma4:31b 큰 컨텍스트 (~4k 입력) | exit0 + judge "내용이 컨텍스트와 일관?" |

### Group B. 코딩 도구 동작 — read/edit/write/list skills

`naia-agent` 의 `createReadFileSkill`, `createWriteFileSkill`, `createEditFileSkill`, `createListFilesSkill`, `createCodingSkill` 이미 구현. 실제 코딩 워크로드로 검증.

| ID | 시나리오 | 평가 |
|---|---|---|
| B1 | 임시 디렉토리에 README.md 생성 요청 → write_file 호출 → 파일 존재 확인 | 파일 존재 + content non-empty + judge "내용이 자연스러운가?" |
| B2 | 코드 파일 (hello.py) read → "이 함수가 뭐 하는지 설명" | exit0 + judge "함수 동작 정확히 기술?" |
| B3 | 코드 refactor — input 검증 추가 요청 → edit_file 호출 → diff 확인 | diff 비-zero + judge "검증 코드 올바른가?" |
| B4 | list_files — 임시 디렉토리 구조 묻기 | exit0 + judge "파일 목록 정확?" |
| B5 | bug fix — 의도적 버그 코드 → 진단 + 수정 패치 제안 | judge "원인 진단 + 수정 둘 다 맞는가?" |

### Group C. Tool-calling / pi loop — 도구 호출 메커니즘

`InMemoryToolExecutor` + `Agent#run` tool-hop 루프 검증. Gemma family는 native tool-calling 없으므로 client-side emulation.

| ID | 시나리오 | 평가 |
|---|---|---|
| C1 | bash skill — `echo Hello` 요청 → tool.started → exit0 | stderr 의 `[tool] bash(...)` 마커 확인 |
| C2 | tool-hop 예산 — 무한 루프 prompt → `maxToolHops` 도달 → graceful exit | "max tool-hop budget" 메시지 |
| C3 | `--no-tools` 비교 — tool 필요한 작업 (e.g. "cwd 파일 목록") → 거절 OR 추측만 | judge "도구 없이 fabricate 했는가?" |
| C4 | refuse on noop — 빈 input 으로 bash 호출 시도 → safe rejection | exit !=0 OR clean error |
| C5 | tool authorization stub — direct mode 에 ApprovalBroker 없을 때 graceful error | "tool approval not wired" 명확 |

### Group D. naia-adk hooks·skills 통합 — FileSkillLoader 라이브

naia-adk 의 `skills/` 외부에서 skill 로드 후 naia-agent 가 실행.

| ID | 시나리오 | 평가 |
|---|---|---|
| D1 | FileSkillLoader 로 naia-adk `skills/time/` 로드 → "지금 몇 시야" → time skill 호출 | tool log 에 time skill 호출 마커 |
| D2 | naia-adk `skills/weather/` 로드 → "서울 날씨" → weather skill 호출 | 메커니즘 (호출 됐는가) — 외부 API 통신 불요 시 stub |
| D3 | naia-adk hooks — `.agents/hooks/policies/` 정책 hook 로딩 검증 | 메커니즘 (정책 fire 되는가) |
| D4 | skill prefix isolation — `SkillToolExecutor` prefix 분리 → 다른 prefix 호출 거절 | 명확한 거절 메시지 |
| D5 | skill not found — 없는 skill 이름 호출 → graceful error | exit !=0 + 명확 메시지 |

### Group E. business-adk RAG/LangGraph 자원 reserve

business-adk 는 **team + RAG + LangGraph 외부 자원**. 본격 통합은 별 슬라이스이지만, naia-agent 가 그 진입점을 **reserve**(blocking 안 함) 함을 검증.

| ID | 시나리오 | 평가 |
|---|---|---|
| E1 | `--service <manifest>` 에 `backend:"langgraph"` 라우팅 stub → unknown backend 명확 메시지 | exit !=0 + 명확 |
| E2 | manifest `backend:"rag-retriever"` stub → unknown backend 명확 | exit !=0 + 명확 |
| E3 | env `NAIA_BUSINESS_TEAM=…` 무시 안 됨 (reserve) — present 이면 show 에 표시 | show 출력에 표시 OR 무시 정책 명확 |
| E4 (deferred) | LangGraph 실 노드 라우팅 — 별 슬라이스 | CHANGELOG defer |
| E5 (deferred) | RAG retriever 실 호출 — 별 슬라이스 | CHANGELOG defer |

### Group F. naia-os 페르소나 주입

**페르소나 입구 컨벤션** (v2 명시): naia-os ChatPanel → naia-agent 의 호출 인터페이스를 한 줄로 결정해야 함. 옵션:
1. `--system "<persona text>"` CLI 플래그
2. stdin 의 첫 `---` separator 위쪽을 system 으로 분리
3. `--persona-file <path>` 파일 경로 인자

**1차 선택**: `--system` (가장 명시적, naia-os 도 이 인터페이스 사용). cross-review 통과 시 구현.

naia-os ChatPanel → naia-agent 호출 시 **페르소나 prompt 를 system 으로 주입**. naia-agent 가 이를 받아 main role 의 system rider 와 합성하는 능력 검증.

| ID | 시나리오 | 평가 |
|---|---|---|
| F1 | stdin 또는 `--system "<persona>"` 으로 페르소나 주입 → 응답이 페르소나 톤 따르는가 | judge "응답이 페르소나 caracter 일관?" |
| F2 | 페르소나 + memory 조합 — 페르소나 가 "당신은 학원 선생" 일 때 첫 turn 자기소개 | judge "역할/이름 페르소나와 일치?" |
| F3 | 페르소나 override `--no-default-system` — 페르소나만 단독 | judge "default rider 미주입 확인?" |
| F4 | 페르소나 길이 — 4KB persona 정상 처리 | exit0 + content non-empty |
| F5 | 페르소나 충돌 — 페르소나 "한국어로만" vs default rider "Reply in the user's language" + 영어 입력 | judge "페르소나 우선?" |

### Group H. 에러 처리 (v2 신설 — GLM gaps#2)

| ID | 시나리오 | 평가 |
|---|---|---|
| H1 | LLM 서버 다운 (port 폐쇄) 중 chat — REPL 생존 + 명확 메시지 | safeTurn hint + exit !=0 |
| H2 | 잘못된 manifest (불완전 JSON) — graceful + 경로 surface | exit !=0 + 경로 포함 |
| H3 | skill 로드 실패 (없는 디렉토리 `--skills-dir`) — graceful | exit !=0 + 명확 |
| H4 | embed 모델 다운 — `--memory` 실패 시 actionable hint | "fix naia-settings/llm.json" |
| H5 | 잘못된 baseUrl scheme — login 시 거절 | parseRoleSpec 시점 차단 |

### Group I. 보안 표면 (v2 확장 — GLM gaps#4)

| ID | 시나리오 | 평가 |
|---|---|---|
| I1 | login --main 에 raw `sk-ant-` 포함 (Anthropic style) → 거절 | exit !=0 + 거절 메시지 |
| I2 | login --main 에 `AIza…` (Google style) → 거절 | exit !=0 |
| I3 | login --main 에 `ghp_…` (GitHub) → 거절 | exit !=0 |
| I4 | show 출력에 keychain 값 노출 0 — 이름만 | grep value-pattern 0 hit |
| I5 | stderr/stdout 환경변수 값 leak 0 — name 만 | grep `<value>` 0 hit |
| I6 | naia-settings/llm.json 에 raw secret value 들어 있으면 reader 거절 | exit !=0 + 명확 |

(기존 G1~G4 일부 흡수, neg-/pos-control 분리)

### Group J. 복합 워크로드 (v2 신설 — GLM gaps#5)

| ID | 시나리오 | 평가 |
|---|---|---|
| J1 | 다중 skill (read+write+list) — "이 디렉토리에 README 추가" → list → write → list-check | 3 tool 호출 + 파일 존재 + judge 자연스러움 |
| J2a | persona + memory — 페르소나 가진 채 fact 저장 → 새 process 회상 | judge "회상 + 페르소나" |
| J2b (deferred) | persona + memory + tool 3-axis | v3 단순화, defer |
| J3 | multi-turn REPL (3턴 이상) fail-survival — 1턴 실패 → 2턴 정상 | 메커니즘 (REPL 살아있는가) |
| J4 | tool-hop budget exhaust → graceful exit | "max tool-hop budget" 메시지 |

### Group K. 모델 비교 (v2 신설 — GLM missing#4)

| ID | 시나리오 | 평가 |
|---|---|---|
| K1 | 동일 prompt — gemma3n:e4b vs gemma4:31b 응답 길이/품질 비교 | judge 2개 비교 + diff 보고 |
| K2 | persona 보존도 — e4b vs 31b 어느 쪽이 페르소나 톤 유지? | judge 비교 |
| K3 (deferred) | tool 사용 — e4b vs 31b — | over-broad, defer |

(v3: K2 도 deferred. K1 (응답 비교) 만 active.)

### Group G. onmam-adk·onmam-dev 도메인 적용

onmam-adk skills (channel-management, doc-coauthoring, sms 등) + onmam-dev GCE 환경 → 실제 도메인 task 워크로드. naia-agent 가 **외부 도메인 ADK** 도 동일하게 import 함을 검증.

| ID | 시나리오 | 평가 |
|---|---|---|
| G1 | onmam-adk `skills/channel-management/` 로드 → "채널 목록" 요청 → skill 호출 마커 | 메커니즘 (호출 됐는가) |
| G2 | onmam-adk `skills/doc-coauthoring/` 로드 → "기술스펙 초안" → skill 호출 | judge "DCO 단계 패턴 따르는가?" |
| G3 | onmam-dev GCE script 가용성 — env injection 으로 GCE host 변수 surface 가능 | mechanism (env 가 show 에 노출?) |
| G4 (deferred) | onmam-dev 실 GCE 호출 | CHANGELOG defer (사용자 게이트 — 외부 서버 변경 금지) |
| G5 | onmam-adk vs naia-adk 동일 skill 이름 충돌 — 우선순위 명확 | mechanism (어느 쪽이 이김) |

---

## 3. LLM-as-judge 모듈

### 3.1 Judge 모델 선택

- **GLM 외주** (`GLM_API_KEY` 가용) — 강모델, 정확, **합성 입력만 송신**(테스트 텍스트). 사용자 기억 외주화 X → privacy 정책 위반 아님 cf [[feedback_naia_reasoning_locality]]
- 대안: 로컬 `gemma3n:e4b` self-judge — 작아도 binary classifier 충분. self-judge bias 회피 (피판정 모델은 gemma4:31b, judge 는 gemma3n:e4b — family 같지만 size·architecture 다름)

**1차 선택**: **GLM** (강모델, 외주 OK). **fallback**: e4b (GLM 미가용 시).

### 3.2 Judge prompt 패턴 (결정적)

```
SYSTEM:
You are a strict but fair evaluator. Return ONLY this JSON shape:
{"pass": boolean, "reason": "one short sentence"}.
No reasoning channel, no Markdown, no preamble.

USER:
Scenario: <id> — <description>
Expected behavior: <bullet>
Observed response (verbatim, may include tool logs):
<<<
<observed>
>>>
Question: Did the response satisfy the expected behavior?
```

- `temperature: 0`
- `max_tokens: 200` (1-sentence reason + JSON 충분)
- 응답 JSON parse 실패 시 fail-safe = `pass:false, reason:"judge parse error"`

### 3.3 Judge 결과 기록

```json
{
  "scenarioId": "A2",
  "tier": "24g",
  "model": "gemma4:31b",
  "judgeModel": "glm-4-flash",
  "runs": [
    {"observed": "...", "exitCode": 0, "judge": {"pass": true, "reason": "..."}}
  ],
  "verdict": "PASS|FAIL|FLAKY",
  "wallMs": 12345
}
```

**v2 수정**: 1-run 기본 (시나리오 수 30+ → 시행 시간 보존). FLAKY 판정은 명시 시나리오만 3-run.

### 3.4 Judge self-consistency probe (v2 신설 — GLM judge_concerns#5)

10개 시나리오마다 1회만: 같은 (scenario, observed) 쌍을 judge 에 **연속 2회** 호출. 일치 = binary. 보고서에 `judge_consistency_rate` 기록. (v3: 단순화 — N=10 fixed, binary, no >90% threshold).

### 3.5 페르소나 충돌 가드 (v2 신설 — GLM missing#5)

F2/F5: 페르소나가 default rider (`MEMORY_PERSONA`) 와 충돌 시 — 페르소나 우선 OR 경고. judge 평가: "응답이 페르소나 우선 따랐는가?".

---

## 4. Cross-review (다른 AI)

사용자 명시: "**다른 ai들과 이 관점에서 테스트들 먼저 설계**". 가용 도구:

1. **Codex / GLM 강모델 reviewer** — naia-agent 의 자체 `aux/reviewer` config (login --sub 로 GLM 등록 후 별 호출).
2. **Gemini CLI** — naia-adk 4-mirror harness 의 `GEMINI.md` 가 동일 SoT 라 Gemini 도구도 본 design 을 같은 입력으로 받음.
3. **opencode** — `OPENCODE.md` 동일 SoT.
4. **Claude Code self** — 보수적 다른 라운드.

**1차 cross-review 대상**: GLM (가장 가용). 한 라운드 충분 — design 수정사항 흡수 후 구현 진입.

---

## 5. Ralph 자동개선 loop

```
while True:
  results = run_all_scenarios()
  if all PASS for 2 consecutive runs:
    commit + push + report
    break
  failures = [s for s in results if s.verdict != "PASS"]
  for f in failures:
    diagnose(f)            # 어떤 컴포넌트?
    patch(f)               # bin/runtime 수정 또는 시나리오 정정 (over-fit 방지)
  rerun(failures)
```

**Over-fit 방지** ([[feedback_naia_agent_general_purpose_no_overfit]]): 시나리오 fail 이 모델 능력 한계 → naia-agent 코어에 모델별 분기 X. 합성 입력 정정 OR 시나리오 deferred 처리. 코어 수정은 **범용 결함** 일 때만.

**v3 가드 (GLM ralph_concerns 흡수)**:
- `max_iterations = 5` — 무한 루프 방지. 5 후에도 미수렴 → 보고 + 사용자 게이트.
- `timebox = 60min` — 최대 시행 시간 (벽시계). 초과 → 부분 결과 commit + 보고.
- 시나리오 정정 vs 코어 수정의 가드: **코어 수정은 ≥2 시나리오가 같은 근본 원인** 일 때만. 1 시나리오 fail → 시나리오 / 합성 입력 정정 우선.

---

## 6. Deferred (의도적, 3중 기록 — CHANGELOG/user-guide/test)

- `--key REF=VAL` 라이브 write (Phase 별)
- Multi-turn REPL PTY emulation
- 24G live full coverage (Group A 외 시나리오들의 24G 재실행은 Group A로 한정)
- baseURL `?key=…` URL sanitization
- RBAC E2E
- Claude Code live-subscription
- SDLC artifact production (강 backend)
- LangGraph 실 노드 (E4)
- RAG retriever 실 호출 (E5)
- onmam-dev GCE 실 호출 (G4)

---

## 7. 합격 기준 (이 슬라이스 = Slice 3-XR-G)

1. **Group A~D, F**: 80% 이상 PASS (개별 시나리오 PASS verdict). FLAKY 허용 = 시나리오 자체 안정성 부족 → 정정.
2. **Group E**: reserve 메커니즘만 검증 (stub fail-graceful). 실 호출은 deferred OK.
3. **Group G**: D 와 같은 메커니즘 적용성 확인. 실 GCE 는 deferred.
4. **2-consecutive 적대 리뷰 CLEAN** — 기존 [[project_task3_cross_repo_connection_2026_05_20]] 패턴.
5. **JSON 결과 파일 + 보고서** — `.agents/progress/integration-scenarios-results-2026-05-20.json` + `.md`.
6. **푸시 대상**: `nextain/naia-agent` (`migration/slice-r6-sb1-manifest-loader` 또는 새 브랜치).

---

## 8. 변경 영향 (over-fit 회피 가드)

- bin/naia-agent.ts: `--persona <path|inline>` 또는 `--system <inline>` 추가? naia-os ChatPanel 호출 컨벤션 따라야 — 추가 전 cross-review.
- packages/runtime: FileSkillLoader 외부 디렉토리 inject CLI 진입점 — `--skills-dir <path>` 추가? 또는 manifest 통해서? 추후 결정.
- packages/core: 변경 없음 (코어 안정).

---

## 9. 다음 단계

1. 이 design 을 GLM 으로 cross-review (1라운드)
2. design v2 확정
3. `packages/cli-app/src/__tests__/integration-scenarios.test.ts` + `lib/llm-judge.ts` 신설
4. Group 별 시나리오 채우기 + 실측
5. Ralph loop
6. 2-consecutive CLEAN → push + 보고

---

## Cross-refs

- [[project_task3_cross_repo_connection_2026_05_20]] — 단위 테스트(22+2) 마무리
- [[project_naia_agent_two_tier_llm]] — main mode-A + aux/reviewer
- [[project_naia_own_orchestrator_pi_substrate]] — pi extension 미래 substrate
- [[project_naia_infra_public_private_split]] — 공개/비공개 split
- [[feedback_naia_agent_general_purpose_no_overfit]] — 코어 over-fit 금지
- [[feedback_naia_reasoning_locality]] — 외주 OK 경계 (합성 입력만)
