# Slice 3-XR-H + I → J → L 진행 계획 (2026-05-20)

**상태**: PLAN — 사용자 게이트 OK ("그렇게 계획 세우고 컨텍스트 작성후 진행해").
**선행 완료**: 3-XR-E (CLI UX) / 3-XR-F (단위 22+2) / 3-XR-G (통합 26+1) / 3-XR-I (pi 코딩 라이브 Group P 6/6).
**deferred**: 3-XR-K (business-adk LangGraph/RAG **실 구현**) — 흔적은 J commit에 끼워넣은 작은 reserve로 충분.
**stale**: 3-XR-M (REPL PTY + live Claude-Code), 3-XR-N (cross-OS), 3-XR-O (Claude Code parity) — 별 트랙.

---

## 1. Slice 3-XR-H — multi-judge ensemble (현재 진행 중)

### 사용자 배경
GLM 단독 외주 = pi 핀번들 substrate 의도 위반 ([[feedback_pi_substrate_not_glm_only_2026_05_20]]). 모든 4 CLI 가용 (claude 2.1.145 / codex 0.130 / opencode 1.15 / gemini 0.42) + GLM HTTP. 3-judge ensemble 로 per-provider bias 정량화.

### 산출
- `lib/llm-judge.ts` 에 `judgeClaude` / `judgeCodex` / `judgeEnsemble` 추가 — **완료, type-check pass**.
- `EnsembleVerdict` interface: `{pass, reason, glm?, claude?, codex?, agreeRate, validCount, infraErrorCount}`.
- 집계 규칙: infra-errored 판사 제외 → 남은 판사들의 strict majority → ensemble verdict.
- `ensembleAvailable()` 헬퍼: 3-CLI invokable 여부 probe (5s 바운드).
- **opencode / gemini 제외**: 사용자 명시 "glm, codex, claude 외주 테스트" — 다른 두 CLI는 미사용.

### 적용 범위 (시나리오 비용 의식)
**모든 시나리오에 ensemble = 안 함** — codex/claude exec 가 GLM HTTP보다 5-10배 느림 + 토큰 비용. 

핵심 2-3개 시나리오만 ensemble 채택 (high-judgment, high-cost):
- **A1** Korean greeting (페르소나 톤 + thinking-mode bleed 검출)
- **A4** no-tools refuse-fabricate (사실성 / 거절 명확성 — judge 모호 영역)
- **F2** persona + memory composition (2-axis verdict — 회상 + 톤)

나머지 시나리오 = GLM 단독 유지 (낮은-judgment, 비용 절감).

### Ralph 사이클 (3-XR-H)
1. dry-run probe: 3-CLI 모두 invokable 확인 + JSON parse 가능 확인
2. 핵심 3 시나리오에 `judgeEnsemble` wire-in
3. vitest run (시나리오는 거의 단순, judge 호출만 무거움 — wall 시간 +1-2분)
4. `agreeRate` / `infraErrorCount` 결과 보고서에 기록
5. 2-consecutive PASS 게이트
6. push

### 게이트: 토큰/구독 비용 의식
- claude CLI = Anthropic Claude Code 구독 / API 키 소비
- codex CLI = OpenAI Codex 크레딧 소비
- 사용자 환경에서 이미 두 CLI 가용 = 비용 발생 의식 — **테스트 run 마다 ~6-9 API call** (3 시나리오 × 3 judge)
- README + CHANGELOG 에 비용 의식 명시

---

## 2. Slice 3-XR-J — `--skills-dir` + naia-adk 풀셋 라이브

### 사용자 배경
"naia-adk 안에서는 풀셋으로 끝내봤으면 좋겠어". naia-adk `skills/` 20개 — channel-management / config / cron / diagnostics / doc-coauthoring / document-generation / email / memo / notify / read-doc / review-pass / service-management / sessions / skill-manager / sms / system-status / time / weather / web-monitoring / business.

### 구조 패치 (bin/naia-agent.ts)
1. `--skills-dir <path>` 플래그 추가 (parseArgs)
2. `FileSkillLoader` 로 디렉토리 로드 → `SkillToolExecutor` 로 wrap → `CompositeToolExecutor` 로 기존 `[bash, ...file-ops?]` 와 합성
3. workspaceRoot 일관성 — 기존 `args.workdir` 사용 (file-ops 와 동일 boundary)
4. direct mode + service mode 둘 다 동일 wiring

### 작업 분해 (Ralph 사이클 가정)
- naia-adk `skills/` SKILL.md 파일 1개 선택 (e.g. `time` — 가장 단순) → FileSkillLoader 로 invoke → 라이브 시나리오 1개 작성
- 점진적으로 풀셋 확장 (time → weather → channel-management → ...)
- "풀셋" 기준: **모든 SKILL.md 가 valid + invoke 시 graceful** (실 외부 API 호출은 stub OK, ex: weather skill = mock fixture)
- 단일 LLM-as-judge 평가 (GLM, 비용 의식)

### 시나리오 그룹 D (재오픈)
- D1 — FileSkillLoader 로 single skill 로드 + invoke
- D2 — multi-skill (2-3개 동시 로드, prefix isolation)
- D3 — skill not found graceful error
- D4 — skill schema invalid graceful error
- D5 — workspaceRoot 경계 enforcement (`--skills-dir` 가 다른 디렉토리도 OK)
- D6 — naia-adk **풀셋** 20 skill SKILL.md 로딩 + smoke invoke (한 시나리오에 묶음)

### K 작은 reserve (#22와 같이 — 별 commit으로 분리)
- manifest schema enum 확장: `backend: "openai-compatible" | "anthropic" | "vertex" | "langgraph" | "rag-retriever"`
- bin switch arm에 `case "langgraph"` / `case "rag-retriever"` stub 추가: stderr `"naia-agent: backend X not implemented yet (deferred, see issue ...)"` + return null
- 기존 E1/E2 시나리오 메시지 정확화 (generic OR → 정확한 "not implemented" pattern)
- adapter Interface = X (YAGNI 적용, 사용자 결정 2026-05-20)

### Ralph 사이클 (3-XR-J)
1. bin 변경 (--skills-dir 플래그 + Composite wire-in) + K 작은 reserve 별 commit
2. Group D 시나리오 1차 작성 (D1~D6, 6-8개)
3. vitest run → fail 진단 → fix
4. naia-adk `skills/` 20 SKILL.md 점검 + 필요 시 stub 정정
5. 2-consecutive PASS
6. push

---

## 3. Slice 3-XR-L — onmam-adk 도메인 자동 적용

### 사용자 배경
"L도 해야겠네". onmam-adk = naia-business-adk fork + 도메인 (church WP 등). skills 11개 — `business`/`channel-management`/`doc-coauthoring`/`document-generation`/`email`/`read-doc`/`review-pass`/`service-management`/`sms`/`web-monitoring`/`wp-archive`.

### 핵심 가정 (작업 단축 근거)
naia-adk 의 FileSkillLoader 메커니즘이 정상이면 onmam-adk 도 **동일 메커니즘으로 자동 로드 가능** (디렉토리 path만 다름). 즉 #22 풀셋이 끝나면 #24는 **검증 시나리오만 추가**.

### 작업 분해
- Group G (재오픈) — 시나리오 3-4개
  - G1 — `--skills-dir <onmam-adk/skills>` 로드 smoke
  - G2 — onmam-adk 와 naia-adk 동일 skill 이름 (`channel-management`, `doc-coauthoring` 등) 충돌 — 우선순위 명확 (last-loaded? first-loaded? error?)
  - G3 — wp-archive 같은 onmam-specific skill 가용성 (SKILL.md valid)
  - G4 — onmam-dev GCE 실 호출 = 사용자 게이트 (defer)
- 기존 D 시나리오 인프라 재사용 (코드 변경 X, 시나리오만 신설)

### Ralph 사이클 (3-XR-L)
1. Group G 시나리오 신설
2. vitest run (간단함, naia-adk 와 동일 메커니즘)
3. 2-consecutive PASS
4. push

---

## 4. 진행 순서 + 게이트

```
[현재 단계]
├── 3-XR-H (multi-judge ensemble)  ◀━━ ACTIVE
│   ├── llm-judge.ts ensemble 추가 ✅ (type-check pass)
│   ├── dry-run probe (3 CLI invokable + JSON parse)
│   ├── 핵심 3 시나리오 wire-in (A1 / A4 / F2)
│   ├── Ralph 2-consecutive PASS
│   └── push
│
├── 3-XR-J (--skills-dir + naia-adk 풀셋)
│   ├── commit 1: bin --skills-dir + FileSkillLoader wire-in (CompositeToolExecutor)
│   ├── commit 2: Group D 시나리오 (D1~D6)
│   ├── commit 3: K 작은 reserve (manifest enum + stub message + E1/E2 메시지 정확화)
│   ├── Ralph 2-consecutive PASS
│   └── push
│
└── 3-XR-L (onmam-adk 자동 적용 검증)
    ├── Group G 시나리오 (G1~G3, G4=defer)
    ├── Ralph 2-consecutive PASS
    └── push
```

### 모든 슬라이스 공통
- Over-fit guard ([[feedback_naia_agent_general_purpose_no_overfit]]) 유지 — 코어 수정은 ≥2 시나리오 같은 근본 원인일 때만
- judge 비용 의식 — ensemble은 핵심 시나리오만, 나머지 GLM 단독
- 보고서 + CHANGELOG entry per slice
- `.agents/progress/*-results-2026-05-20.json` 머신 데이터 유지

---

## 4.5. Voice 트랙 (#28) 분리 정정 (2026-05-20 다른 세션 정렬)

다른 세션에서 P0c (LiveKit + ko-serve voice pipeline) 를 두 phase 로 쪼갬:

| Phase | naia-agent 의존? | 누가 | 산출 |
|---|---|---|---|
| **P0a** Compatibility smoke gate | ❌ | 다른 세션 (본 세션 OK) | smoke matrix 확인 |
| **P0b** B5-lite contract memo | ❌ | 다른 세션 | 분석 memo |
| **P0c-1** standalone tech demo | ❌ (mock LLM or external OpenAI) | **다른 세션** | `tools/voice_demo_standalone/` smoke_e2e + measure_realtime + vertical_demo + p0c1_metrics.json |
| **P0c-2** naia-agent integration | ✅ 의존 | **우리(나중) 또는 별 세션** | livekit-plugins-naia-voxcpm2 + naia-LLM→LiveKit wrap + VoiceSession + memory hook |

**핵심 교훈**:
- product viability 검증 (LiveKit ↔ ko-serve) 을 naia-agent 통합 위험에서 분리.
- LiveKit / ko-serve 에 critical issue 있으면 naia-agent 안 만지고 발견.
- P0c-1 결과 = tech 증명서. 우리 세션 #28 잡을 때 그대로 reference.
- naia-agent integration = voice cascade 위에 memory hook + vertical policy + naia LLM wrapper 얹는 단순 작업.

**우리 (이번 + 후속) 책임**:
- Task #28 = **P0c-2 naia-agent integration 만**. P0c-1 = 다른 세션 산출.
- M/N/O 슬라이스 끝난 후 또는 별 세션에서 P0c-2 진입.
- P0c-1 reference 문서 (다른 세션 산출물) 가 출발점.

**naia-agent direct path final-text bias 충돌** (Codex r3/r4 핵심 risk) 해결 = #28 P0c-2 슬라이스의 일. P0c-1은 mock LLM으로 회피하고 결합 자체 검증.

---

## 5. Deferred (3-surface 명시 유지)

- **3-XR-K 실 구현** (LangGraph 노드 / RAG retriever) — 흔적은 J commit의 작은 reserve로 충분. 사용자 명시 시 재오픈.
- **adapter Interface 정의** — YAGNI 적용 (사용자 결정 2026-05-20). 실 구현 시점에 처음 잡음.
- **3-XR-M** (REPL PTY + live Claude-Code subscription) — 별 트랙
- **3-XR-N** (cross-OS Windows/Linux full) — sanity 1차 끝남, 본격 별 트랙
- **3-XR-O** (Claude Code 하네스 parity) — 별 트랙
- **3-XR-Voice (#28) = P0c-2 (naia-agent integration) 만** — minicpm 4.5 폐기 대체 (cf §4.5). P0c-1 standalone tech demo 는 **다른 세션이 산출** (LiveKit↔ko-serve, mock LLM, naia-agent 의존 0). 우리 (이번 세션) M/N/O 끝난 후 또는 별 세션에서 P0c-2 진입. P0c-1 결과 reference 사용.
- **opencode / gemini judge** — 사용자 명시 "glm, codex, claude" 3개만. 다른 2 CLI는 별 슬라이스 또는 사용자 명시 시.

---

## 6. 메모리 cross-ref

- [[feedback_pi_substrate_not_glm_only_2026_05_20]] — 사용자 정정, 3-XR-H 동기
- [[feedback_naia_agent_general_purpose_no_overfit]] — 코어 무수정 guard
- [[feedback_naia_reasoning_locality]] — judge 외주는 합성 입력만 OK
- [[project_slice_3_xr_g_integration_2026_05_20]] — 26 시나리오 + 단일 GLM judge baseline
- [[project_slice_3_xr_i_pi_coding_live_2026_05_20]] — Group P 6 시나리오 LIVE
- [[project_naia_own_orchestrator_pi_substrate]] — pi 핀번들 substrate 의도
