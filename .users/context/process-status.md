# 프로세스 현황

> **SoT**: `.agents/context/process-status.json`
> 세션 시작/종료 시 SoT JSON과 이 파일을 동기화.

---

## 참조 링크

| 항목 | 위치 |
|------|------|
| 구조 명세 | [docs/project-structure.md](../../docs/project-structure.md) |
| 규칙 SoT | [.agents/context/agents-rules.json](../context/agents-rules.json) |
| 교훈 | [docs/lessons.md](../../docs/lessons.md) |
| 이슈 문서 | [.agents/progress/](../progress/) |

---

## 현재 작업

### Issue #84 — 개인 라디오 DJ와 회사 전시 소개 제품 검증

**이슈**: [nextain/naia-agent#84](https://github.com/nextain/naia-agent/issues/84)

**상태**: done — exact preference index와 durable Memory outbox, 8개 grounded DJ 멘트,
8시간 lease, 전시 yield/Q&A/resume privacy, file-backed 설정, TTS 두 경로와 6종 제어 Playwright,
실제 Tauri 설정 재수화를 검증했다. 물리 음질·현장 선호도는 별도 운영 관찰 범위다.

**추적**: REQ-013 → UC-015 → SPEC-012 → TEST-S-015 / TEST-F-012

개인 라디오 DJ와 회사 전시 소개는 사용자 입력을 기다리지 않고 시작하는 닫힌 profile이다. 계약/통합
테스트는 DJ 멘트·제어·lease와 전시 yield/resume·stale 폐기를 검증한다. 실제 Tauri 테스트가 증명한
범위는 profile 저장·복원, DJ 실제 YouTube BGM·첫 결과·stop, 전시 greeting·stop이다.

| 게이트 | 상태 | 산출물 |
|---|:---:|---|
| P01 사용자 시나리오 | done | 두 profile과 실제/계약 검증 경계 |
| P02 테스트 시나리오 | done | DJ/전시 계약·통합과 native Tauri 범위 분리 |
| P03 요구사항 | done | FR-CONT-MVP 상태를 Implemented/Partial로 교정 |
| P04 통합 테스트 | done | agent 제품·race·8시간 lease, shell 회귀·Playwright 7건, 실제 Tauri 설정 재수화, Rust build/check |
| P05 완료 | done | REQ-013 자동 제품 수용 범위 Done; 물리 음질·현장 선호도는 운영 관찰로 분리 |

> 아래 내용은 직전 시연 안정화 작업의 보존 기록이다. Issue #82 작업은 기존
> `ollama-provider.ts`의 기존 시연 안정화 동작을 바꾸지 않는다.

### 2026-07-16 핫픽스 — ollama DEFAULT_NUM_CTX 8192→16384

시연 persona(21,187자) 요청이 14,460 토큰으로 8192 한도를 넘어 Ollama 가 400
(`exceed_context_size_error`)으로 전량 거부 — 체감은 "무응답". 요청이 보내는 `num_ctx` 가
modelfile(16384)을 덮으므로 어댑터 기본값 자체를 16384 로 수정. 검증 = uc1-ollama-provider
17/17 + dist 재빌드 + 실기 응답 재개. ⚠️ 잔여: 기본 프롬프트 ~14.5k + 도구 + 히스토리로
여유 ~1.5k 토큰 — 긴 대화는 재초과 가능(후속 = `ollamaNumCtx` 셸 배선 + 히스토리 트리밍).
트랙 = alpha-adk `.agents/progress/naia-demo-knowledge-persona-clobber-2026-07-16.md` 원인 2.

---

**이슈**: UC-THINKING-reasoning-effort-gate ([nextain/naia-agent#80](https://github.com/nextain/naia-agent/issues/80))
**제목**: 추론(thinking) 모델이 생각에 출력 토큰을 다 쓰고 본문을 못 내는 현상 차단 — OpenAI-compat 어댑터가
`enableThinking=false` 를 `reasoning_effort:"none"` 으로 wire 반영(로컬 엔진에만 적용)
**상태**: **done** (2026-07-15)

### 무엇이 문제였나 (실측)

로컬 추론 모델(Qwen3.5 / DNA3.0 계열)로 도구를 켜고 대화하면 **답변이 통째로 비었다.** 에러도 경고도 없이.

| 구성 | 빈 답변 | 틀린 답변 |
|---|---|---|
| thinking **켬**, 컨텍스트 4k | 2/6 | 0/6 |
| thinking **켬**, 컨텍스트 16k | 1/6 | 1/6 (지식과 다른 시각을 지어냄) |
| **thinking 끔**, 컨텍스트 16k | **0/6** | **0/6** |

- 빈 응답의 `finish_reason` 은 잘림(`length`)이 **아니라 `stop`** 이었다 — 모델이 생각을 마친 뒤 본문을
  시작하지 않고 끝낸다. 그래서 **컨텍스트를 키워도 낫지 않는다**(16k 에서도 재현).
- 페르소나로 "생각 과정을 출력하지 마세요"라고 지시해도 **듣지 않았다.**
- OpenAI 호환 경로에서 실제로 듣는 스위치는 **`reasoning_effort:"none"` 하나뿐**이었다.
  (`think:false`·`chat_template_kwargs`·`/no_think` 는 전부 무시됐고, `/no_think` 는 오히려 마크다운 표를
  유발해 음성 합성 경로에 해로웠다.)
- 부수 효과: 완성 토큰 115 → 17~34, 응답 2.2초 → **0.75초**.

측정 환경: RTX 3080 Ti Laptop 16GB · ollama 0.32.0 · 도구 9개 · 2026-07-14.

### 무엇을 고쳤나

`enableThinking` 은 **이미 전 구간에 배선돼 있었다** — 도메인·gRPC·핸들러·셸(기본값 `false`)까지.
그리고 **anthropic·ollama(native) 어댑터는 이미 이 값을 쓰고 있었다.** 오직 **OpenAI 호환 어댑터만
무시**하고 있었다. 그 누락 하나를 메웠다.

⚠️ **반드시 로컬 엔진에만 적용해야 한다.** 셸이 `enableThinking:false` 를 **기본값으로 항상 보내므로**,
게이트가 없으면 gpt-4o·Gemini·GLM 같은 **비추론 원격 모델에 `reasoning_effort` 가 실려 400** 이 난다.
판별은 baseUrl 이 loopback/사설망인지로 한다(순수 함수 `isLocalEngineBaseUrl`).

변경 파일 3개 (도메인 계약·gRPC proto·다른 provider 어댑터는 **건드리지 않음**):

| 파일 | 변경 |
|---|---|
| `src/main/domain/provider-route.ts` | `isLocalEngineBaseUrl()` 순수 판별 함수 신설 |
| `src/main/adapters/openai-compat-provider.ts` | `supportsReasoningEffort` 주입 + 요청 body 선택 필드 1개 |
| `src/main/adapters/provider-resolver.ts` | baseUrl 을 판별해 어댑터에 주입 (라우팅 판단=도메인) |

---

## SDLC 게이트

| 게이트 | 상태 | 산출물(deliverable) |
|--------|:----:|---------------------|
| P01 사용자시나리오 | done | `docs/user-scenarios.md` UC-THINKING + S-THINK-1~3 + 실측 근거표 |
| P02 테스트시나리오 | done | Test Coverage Map: UC-THINKING → `src/test/uc-thinking.contract.test.ts` |
| P03 요구사항 | done | `docs/requirements.md` FR-THINK-1~4 + NFR. 범위 밖(#80) 명시 |
| P04 통합테스트 | done | 신규 계약테스트 **11/11 통과**. 전체 **945 통과·0 실패**(회귀 0). `tsc --noEmit` clean. check-logging·ci-verify-sdlc·check-traceability·check-terminology 통과 |
| P05 완료 | done | FR-THINK-1~4 → Done |

마지막 업데이트: 2026-07-15

---

## 알려진 드리프트 (사전 존재 — HEAD stash 재검사로 확인)

`check-file-anchors` 가 RED 4건이었다. **본 변경 이전부터 있던 것**이다.

그중 **`cli-chat.ts` 는 본 작업이 수정한 파일**이라 앵커를 채웠다 (RED 4 → 3).
계약은 추측하지 않았다 — 형제 파일 `cli-supervise.ts` 와 **같은 UC-CLI 계약서**를 가리킨다.

남은 3건은 **본 작업이 건드리지 않은 파일**이고, 어느 UC/계약에 속하는지는
**추측하지 않는다** → 별도 이슈로 처리한다.

- `src/main/adapters/sub-llm-provider.ts` — 앵커 없음 (memory sub-LLM 로 보이나 미확인)
- `src/main/ports/sub-llm.ts` — 앵커 없음 (동상)
- `src/main/adapters/panel-tool-executor.ts` — stale 앵커: contract 문서가 실재하지 않음

---

## 남은 결함 (#80 — 본 UC 와 분리)

같은 조사에서 드러났으나 **cross-repo wire 변경**(proto `FinishEvent`)을 수반해 분리 보존:

1. 대화 조립 예산이 **도구 스키마를 세지 않는다** — `budgeted-conversation.ts` 의 기본 예산(6000)이
   실제 컨텍스트 창(4096)보다 **크다**. 창을 지켜야 할 가드가 창보다 큰 예산으로 지키고 있다.
2. `ProviderChunk.finish` 에 **사유가 없다** — 잘림(`length`)을 코어에 전달할 수단이 구조적으로 없다.
3. 그래서 **잘림·빈 응답이 성공으로 오인**되어 조용히 통과한다.

---

## 세션 체크리스트

**시작 시**:
- [ ] `process-status.json` 읽기
- [ ] `current_work` 확인
- [ ] `last_updated` 갱신
- [ ] P01~P03 게이트 완료 확인 후 코딩 시작

**종료/커밋 전**:
- [ ] 완료된 게이트 status → done, deliverable 기재
- [ ] `last_updated` 갱신
- [ ] 이 파일 동기화
- [ ] `process-status.json` 커밋에 포함
