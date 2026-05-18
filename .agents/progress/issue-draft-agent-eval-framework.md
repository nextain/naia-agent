> ⚠️ **SUPERSEDED (2026-05-18) — 이 문서는 2026-05-16 프레이밍입니다.**
>
> 현 SoT: gh **nextain/naia-agent#31** = "[R6] Agent Service Builder (우산)" (2026-05-17 재프레이밍).
> 설계 SoT = `nextain/naia-adk : .agents/progress/agent-service-builder-architecture.md` v3 (3-라운드 cross-review + 사용자 합의 2026-05-17).
> 본 문서의 "평가 프레임웍 = 헤드라인" 은 **SB-3 (우산 하위 품질 게이트)** 로 흡수됨. minicpm = **SB-5** (Phase2, ko-serve PAUSED 해제 의존).
> 아래는 5/16 당시 기록(역사 보존)이며 **진입점/SoT 아님** — 따라갈 곳 = #31 + naia-adk v3 SoT.

<!-- 핸드오프 문서 — 다음(별) 세션이 이 아키텍처 작업을 시작하는 진입점.
     ✅ 정식 등록됨: nextain/naia-agent#31
        https://github.com/nextain/naia-agent/issues/31
        (이 파일 = 그 이슈 본문 SoT. master #2 연계·ref-adoption-matrix
         §D/sub-issue 정식화는 다음 세션이 naia-agent process 로.)
     naia-agent dev-process(slice/matrix/F-rules/karpathy) 준수 전제.
     ※ 이 파일이 issue-draft-minicpm-rag-memory-agent-benchmark.md 를 대체
       (재프레이밍: 헤드라인 = 평가 프레임웍, minicpm = 한 backend). -->

# [R6 candidate] naia-agent AI 에이전트 성능 평가 프레임웍

> **본 deliverable = 검증 가능한 agent-flow 성능 평가 프레임웍.**
> minicpm(음성)·RAG·naia-memory 는 그 프레임웍이 *평가하는 구성요소*이지
> 헤드라인이 아님. (이전 draft `issue-draft-minicpm-rag-memory-agent-
> benchmark.md` 의 재프레이밍 — 그 파일은 이 문서로 대체.)

## 0. 다음 세션 시작 가이드 (먼저 읽을 것 — BLOCKING)

1. naia-agent mandatory reads **전부** (AGENTS.md §Mandatory Reads 1~7:
   design-recheck / ref-adoption-matrix / runnable-testable-gap /
   r1-slice-spine / dev-framework-and-process / 상위 4repo plan·directive).
   이 문서 작성자는 그 중 AGENTS.md·agents-rules.json·project-index.yaml·
   voice-pipeline-audit 만 읽음 — 나머지는 다음 세션이 읽고 §D/슬라이스
   판단할 것.
2. ko-serve 연결 계약: `nextain/naia-minicpm-ko-serve :
   .agents/contracts/localmodel-realtime-v2.md` (rev2.1, 2x clean).
3. ko-serve 현황(왜 minicpm 개선이 멈췄나): 그 repo
   `.agents/progress/current.json` (CORRECTION_voxcpm2_streaming /
   DECISION_HELD_native_vs_voxcpm2 / S1d_*).
4. 경계 원칙: naia-agent = RAG·context·기억·에이전트·**평가 프레임웍**.
   ko-serve = serving + 계약 + 자기 gateway (이미 제공). 상호 import X.

## 1. 목적 (헤드라인)

**naia-agent 위에서 "검증 가능한 agent flow"의 성능을 객관 측정하는
프레임웍을 구축한다.** 즉: 에이전트가 (RAG + naia-memory 컨텍스트를
조립해) opt-in 음성 backend(minicpm /v1/realtime)와 결합된 end-to-end
대화를 수행할 때, 그 품질(컨텍스트 적중·한국어·실시간·안정성)을 재현
가능하게(fixture-replay 우선) 측정. minicpm 은 첫 번째 평가 대상 backend.

## 2. 왜 지금 / minicpm 트랙은 왜 멈췄나 (정직)

- minicpm(ko-serve) 개선은 **당장 어려움**: VoxCPM2 = 발화-단위 설계
  (소스 확정, token-interleaved duplex drop-in 불가), 네이티브 Talker
  개선은 GPU 학습 트랙, 패러다임 결론은 OpenBMB Issue #307 답변 대기.
  → ko-serve 트랙 **PAUSED**.
- 그동안 가치 있는 것 = **agent 쪽 프레임웍**(GPU 대부분 불요,
  fixture-replay). 그래서 다음 작업 = 이 프레임웍. minicpm 라이브 e2e만
  GPU/ko-serve worker 필요(Phase 2).

## 3. 연결 계약 (ko-serve 제공, 확정됨)

`localmodel-realtime-v2.md` rev2.1 핵심:
- transport = `WSS {base}/v1/realtime?mode=audio` (OpenAI Realtime
  이벤트). vLLM 미경유 — ko-serve gateway 직결.
- **RAG/memory 주입점 = `session.update.session.context`** (§7) →
  ko-serve gateway 가 `context+"\n"+instructions` 단순 prepend (검색·판단
  X = 경계). ko-serve §8 G3 패치로 가능(커밋 7cc8168).
- 정직한 한계(계약 잠금): §3 절-cadence(빈 audio 정상) / §4 barge-in
  chunk-driven·서버 in-flight 취소 없음 / §5 재개 없음 / §6
  session.update=초기1회·재호출=reset / §8 G1 telemetry.
- ko-serve `/v1/realtime` 라이브 검증 미완(gateway 재시작=GPU 단계).

## 4. 스코프

1. **agent-flow 평가 하니스** (헤드라인): ko-serve backend-only
   realtime_stability 지표(deaf_ms/ttfa/fallback/closed_before_eot, 커밋
   0ce5f16)를 **agent-flow 레벨로 확장** — RAG+memory+backend end-to-end
   품질(컨텍스트 적중, 한국어, 실시간, 안정). fixture-replay 우선
   (G15: ANTHROPIC_API_KEY 없이 CI pass).
2. **minicpm /v1/realtime connector** (interface, not dependency):
   v2 계약 따르는 TS 클라이언트, host 주입(`HostContext`),
   `examples/minicpm-realtime-host.ts`. = 평가 프레임웍의 첫 backend.
3. **RAG + naia-memory context 조립**: 기존 `@nextain/naia-memory` v6.0
   (examples/naia-memory-host.ts, hardened-sqlite-host.ts, MemoryProvider
   tiered recall) + RAG → turn 전 `session.update.context` 주입 flow.
   RAG layer = naia-agent 신규.

## 5. 비-스코프

- ko-serve 모델/serving 변경(별 repo, v2 계약 이미 제공).
- VoxCPM2 라이브 Talker / minicpm 패러다임 결정(ko-serve 트랙, #307 대기).
- 음성 Option C(TTS=agent/STT=shell) 재설계 — minicpm=omni 라 split
  우회. 양립은 ref-adoption-matrix §D 결정(이 이슈는 *제기*만).
- D1~D8(F06) / 4repo plan Part A(F07) 수정.

## 6. 프로세스 위치 / 게이트 (정직)

- naia-agent phase = **R5 LOCKED**. 이 작업 = **R6 candidate**. 신규
  패턴(omni-localmodel-as-non-LLMClient backend + context 주입 + agent-
  flow eval) → AGENTS 규칙 #4: ref-adoption-matrix **§D 항목 신설 +
  sub-issue** 필요. 다음 세션이 mandatory reads 후 §D/슬라이스 확정.
- 코드 착수 게이트: F01(스켈레톤/슬라이스), slice S01~S04, matrix ID
  citation, karpathy 4원칙. 이 문서는 *계획* 산출물(코드 아님).

## 7. 할 일 — GPU 유무 분리

### Phase 1 — GPU 불요 (다음 세션 바로 가능)
- [ ] mandatory reads 완독 → ref-adoption-matrix §D 항목 + sub-issue(#2 하위) 등록
- [ ] agent-flow 평가 하니스 설계 (지표·fixture-replay 스키마·G15)
- [ ] v2 계약 → TS 인터페이스 타입 초안 (`@nextain/agent-types` 영향 검토)
- [ ] minicpm connector 설계 (이벤트 매핑, context 주입 시점, §4/§5 한계 반영)
- [ ] RAG+memory→context 조립 flow 설계
- [ ] (F01/slice 충족 시) `examples/minicpm-realtime-host.ts` + fixture + unit test 스켈레톤

### Phase 2 — GPU 필요 (ko-serve worker, 별도)
- [ ] ko-serve worker+gateway 재시작 → `/v1/realtime` 라이브 e2e (G3 context / G1 telemetry 실검증)
- [ ] 실 backend 통합 검증(S03) — agent+RAG+memory+minicpm 라이브
- [ ] agent-flow 벤치 실측 → 품질 baseline

## 8. Acceptance (slice success criterion)

S01 새 실행 명령 · S02 unit test 1+ · S03 통합검증(Phase1 fixture-replay
/ Phase2 실 backend) · S04 README·CHANGELOG · matrix §D ID 인용.

## 9. Cross-ref

- ko-serve(`nextain/naia-minicpm-ko-serve`) = PAUSED. agent-flow 평가
  프레임웍은 **여기(naia-agent)** 책임. ko-serve `current.json` 에 본
  문서로의 포인터 기록됨(cross-ref).
- 외부(gh issue create / push) = 사용자 승인. 이 문서는 핸드오프 draft.
