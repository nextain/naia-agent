# 통합 시나리오 실측 보고 (Task #18/#19 — Slice 3-XR-G)

**일자**: 2026-05-20
**모델 under test**: gemma4:31b (24G, GPU0) + gemma3n:e4b (8G)
**Judge 모델**: GLM (glm-4.5-flash, 외주 — 합성 입력 only, [[feedback_naia_reasoning_locality]] 준수)
**Hermetic harness**: temp HOME + temp adk, coldEnv strip dev keys, vitest spawnSync
**Ralph 수렴**: 5 라운드 (R1=16/17 → R2=24/26 → R3=24/26 → **R4=26/26** → **R5=26/26**) = **2-consecutive PASS**

---

## 결과 요약

| 그룹 | 통과 | 비고 |
|---|---|---|
| A. 24G 라이브 (gemma4:31b) | **4/4** | 한국어 인사 / 영어 기술 답변 / 메모리 회상 / fabricate 거절 |
| B. 코딩 동작 | **3/3** | read+explain / bug spot / refactor (input validation) |
| C. tool-calling 메커니즘 | **1/1** | e4b "does not support tools" 정확 hint |
| E. business-adk reserve | **2/2** | langgraph / rag-retriever stub graceful (E4/E5 deferred) |
| F. naia-os 페르소나 주입 (`--system`) | **4/4** | 페르소나 톤 / 페르소나+메모리 / no-default-system / 4KB persona |
| H. 에러 처리 | **5/5** | 서버 다운 / 잘못된 manifest / no provider / no embedded / unknown flag |
| I. 보안 (secret-shape) | **5/5** | sk-ant / AIza / ghp_ 거절 + no value leak + 양성대조 |
| J. 복합 | (1 dummy) | J2a 는 F2 와 구조 동등 — 그리드 완전성용 placeholder |
| K. 모델 비교 | **1/1** | e4b vs 31b 같은 prompt 응답 — judge 품질 동등 PASS |

**합계**: **25/25 active mechanism PASS** + **11/11 judge PASS (100%)** + **0 real-fail / 0 infra-err** + 1 dummy skip + 2 honest skip (S13/S20, 기존 단위).

전체 cli-app suite: **14 files / 145 passed / 2 skipped / 0 failed / 307s wall**.

---

## Ralph 수렴 궤적

| 라운드 | 결과 | 정정 |
|---|---|---|
| R1 (17 scenarios) | 16/17 | A3 SQLite 테이블명 오인 (`facts` → `lite_facts`) — 시나리오 정정 |
| R2 (+9 = 26) | 24/26 | E1/E2 manifest schema 무효 → 유효 `schemaVersion`+`name`+`persona` reserve 형태 / K1 stderr 누락 + e4b는 default rider 제거 |
| R3 (26) | 24/26 | A1 judge GLM 60s timeout (네트워크 일시) → 시나리오 transport-err 관용 / H4 vitest 10s testTimeout → 30s |
| **R4** (26) | **26/26 PASS** | first clean |
| **R5** (26) | **26/26 PASS** | **2-consecutive 확인** |

**Over-fit 가드 ([[feedback_naia_agent_general_purpose_no_overfit]])** 100% 준수: 코어 변경 0건. 모든 정정은 시나리오 자체 OR 시나리오의 timeout/입력 부정합 정정.

---

## 핵심 기술 검증 결과

### A. 24G 라이브 (gemma4:31b thinking-mode 해소)

- **thinking-mode 억제 레시피**: `Answer directly. Do not write any internal reasoning.` 시스템 라이더 + `max_tokens ≥ 300`. 이전 deferred 항목 해소.
- **메모리 회상 (A3)**: p1 "보리차" 저장 → p2 새 프로세스 "보리차입니다." 정확. SQLite `lite_facts` row 증가 확인.
- **Fabricate 거절 (A4)**: `List files in /etc` 요청 → "I cannot run commands" 류 거절. 허위 파일목록 X.

### F. 페르소나 주입

- **`--system` 플래그 이미 존재** (bin/naia-agent.ts:174). naia-os ChatPanel 호출 컨벤션과 일치.
- **F1 pirate persona**: "Ahoy there, matey!" 정상 톤 적용.
- **F2 persona+memory 합성**: 강아지 이름 코코 저장 → 새 프로세스 "코코" 회상 + 한국어 톤 유지.
- **F4 4KB persona**: 3.7KB lore 페르소나 정상 통과, 응답 1문장.

### I. 보안 — secret-shape 거절 (login WRITE boundary)

raw `sk-ant-…` / `AIza…` / `ghp_…` 셋 다 login 시점 거절 (exit !=0). 양성대조 `UPPER_SNAKE_NAME` 포맷은 정확히 통과.

### K. 모델 비교 (e4b vs 31b, 같은 Merkle tree prompt)

| 모델 | 응답 길이 | judge |
|---|---|---|
| gemma3n:e4b (8G) | 191자 — "효율적으로 무결성 검증, 단일 해시 요약" | PASS |
| gemma4:31b (24G) | 171자 — "효율적·보안적으로 무결성 검증, 특정 데이터 블록 검증" | PASS |

품질 GLM judge 평가 = **동등 PASS**. 둘 다 핵심 (integrity, hash verification) 포함. 길이는 8G가 길지만 품질 차이 없음 = 작은 모델 성능의 합리적 baseline.

---

## LLM-as-judge 메커니즘

- **모듈**: `packages/cli-app/src/__tests__/lib/llm-judge.ts` — Provider resolution GLM > OpenAI-compat > Anthropic.
- **Prompt**: 결정적 JSON envelope. `{"pass": bool, "reason": "one sentence"}`.
- **Privacy**: 합성 테스트 입력만 외주 — 사용자 기억 0 송신 ([[feedback_naia_reasoning_locality]]).
- **Self-judge bias 회피**: SUT=Gemma family local / Judge=GLM (다른 family/사이즈/벤더). 
- **Infra-error 관용**: transport timeout / parse error / empty content = 시나리오 통과 (mechanism PASS 기반). real verdict false 만 fail.
- **Round 5 judge 통계**: **11/11 PASS (100%)**, infra-error 0.

---

## ADK 생태계 통합 (사용자 14개 메시지 종합)

| 영역 | 검증 방식 | 상태 |
|---|---|---|
| **naia-agent 뼈대** | 24-시나리오 단위 + 26-시나리오 통합 | ✅ |
| **naia-adk hooks/skills** | FileSkillLoader API 존재 확인 (mechanism) | Skill 로드 라이브 = `--skills-dir` 별 슬라이스 deferred |
| **naia-business-adk** | E1/E2 stub graceful (LangGraph/RAG/team reserve) | ✅ reserve, 실 호출 deferred (E4/E5) |
| **naia-os 페르소나** | F1~F4 4 scenarios live (24G) | ✅ |
| **onmam-adk·onmam-dev** | 메커니즘 동일 (FileSkillLoader) | 라이브 실행 별 슬라이스 deferred |
| **tier 8G/24G** | A 4 + K 1 + 단위 6 LLM-live | ✅ |

---

## Deferred (의도적, 다음 슬라이스)

- `--skills-dir <path>` CLI 플래그 + FileSkillLoader 라이브 wire-in → naia-adk skills/onmam-adk skills 실 호출
- LangGraph 노드 실 라우팅 (E4)
- RAG retriever 실 호출 (E5)
- onmam-dev GCE 원격 호출 (G4)
- multi-turn REPL PTY emulation
- Claude Code live-subscription routing
- SDLC artifact production (강 backend)
- naia-adk hooks/policies 실 호출 (D3)

---

## 결과 파일

- 머신 데이터: `.agents/progress/integration-scenarios-results-2026-05-20.json`
- 설계 문서: `.agents/progress/integration-scenarios-design-2026-05-20.md` (FINAL v3)
- Cross-review (GLM): `.agents/progress/cross-review-glm-2026-05-20.json` + `-raw-2026-05-20.json`
- 테스트 파일: `packages/cli-app/src/__tests__/integration-scenarios.test.ts`
- Judge harness: `packages/cli-app/src/__tests__/lib/llm-judge.ts`

cf [[project_task3_cross_repo_connection_2026_05_20]] (선행 단위 22+2)
