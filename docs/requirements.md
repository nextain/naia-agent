# Requirements (P03) — FR / NFR

정본 요구사항 인덱스. UC 별 FR/NFR 의 권위 계약서는 `docs/progress/UC*-contract*.md` 이며, 이 문서는
집약 인덱스다(SDLC P03 산출물). UC1/UC5/provider-provenance FR 은 각 계약서 참조.

## UC-memory FR/NFR (FR-MEM-1 ~ 8)

권위 계약서: `docs/progress/UC-memory-recall-save-contract-2026-06-12.md`.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-MEM-1 | 턴 전 recall — *이 턴의 새 user 입력*(마지막 메시지가 user 일 때)로 `recall(query)→RecalledMemory`, domain formatter 로 블록화해 systemPrompt 주입. abort+deadline(5s) race. | Done |
| FR-MEM-1a | 빈/공백 query = backend 호출 없이 빈 회상(무관 민감정보 주입 방지). | Done |
| FR-MEM-2 | 턴 후 save — provider 최종 응답=커밋 지점에서 user+assistant(턴 전체 텍스트) 저장. save→finish 순서. deadline(5s) bound. 취소 의미="저장된 턴=finish 된 턴". | Done |
| FR-MEM-3 | 옵셔널·비파괴 — memory 미주입=무회귀. recall/save throw·hang·로거 throw 해도 턴 유지(terminal 1회·usage 1회 불변식 보존). | Done |
| FR-MEM-4 | 실 import — 어댑터가 `@nextain/naia-memory` MemorySystem(LocalAdapter) 실제 사용. | Done |
| FR-MEM-5 | project 격리 — scopeMode "strict" 기본(soft 누설 차단). | Done |
| FR-MEM-6 | 종료 드레인·영속 — EOF 시 drain→close(flush)→stdout flush→exit. 30s 종료 grace 안전망. | Done |
| FR-MEM-7 | bounded 주입 — 항목/블록 하드 캡, 프레이밍 floor 보존(body 만 절단). | Done |
| FR-MEM-8 | 비신뢰 회상 — 신뢰 경계 표시 + 직접 경계-위조 방지(완화책; 모델 순응 차단은 *미보장*, 잔여 위험 명시). | Done |
| FR-MEM-9 | 단일-project-per-process + workspace identity = 영속 UUID(`<adkPath>/.naia/workspace-id`). 정본: override → UUID → 실패 시 memory 비활성(fail-closed). 이동 연속·경로 재사용 누설 차단·동시부팅 배타생성. makeNaiaMemory project 필수+비공백. | Done |
| FR-MEM-10 | 출처 보존 — recall 이 episode role(user/assistant) 보존, formatter 가 사용자 진술/assistant 생성물(미검증) 구분(자기증폭·확증루프 방지). | Done |

### NFR
- 헥사고날 경계: domain 순수(formatRecalledMemory)·app 포트만·adapter 데이터만(프롬프트 정책 비누출).
- 불변식: terminal 래치(finish XOR error 1회)·usage=terminal 직전 1회·registry finally 해제 — memory 경로 무영향.
- recall 정확성은 content+project 기반(session/encode 순서 무관) → 동시 턴 교차 안전.

## UC-PROV FR/NFR (FR-PROV-1 ~ 3)

권위 진행문서: `.agents/progress/new-naia-provider-wiring-2026-06-17.md`.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-PROV-1 | config-first precedence — naia-settings `loadMain` 이 `config.json`(naia-os 셸 정본)을 `llm.json`(구 CLI)보다 먼저 읽는다. desktop SoT 원칙; stale `llm.json` 이 UI 선택(config.json)을 그림자 처리(shadow)해 openai-compat 크래시를 유발하면 안 됨. | Done |
| FR-PROV-2 | 라이브 설정 reload (R1-2) — 사용자가 naia-os 에서 provider/model 교체 → OS 가 naia-settings 갱신 후 `ReloadSettings`/`SetWorkspace` 재호출 → agent 가 활성 `defaultConfig` 를 재기동 없이 swap. startup-only 금지(R1-2). | Done |
| FR-PROV-3 | native host-override gating — `naiaGatewayUrl`/`NAIA_ANYLLM_BASE_URL` 는 nextain(lab-proxy) 전용. native provider 는 고정 공개 endpoint(또는 `vllmHost`/`ollamaHost`/`llm.json` baseUrl). config 에 남은 stale `naiaGatewayUrl` 이 native provider 를 오라우팅하지 않도록 게이트. | Done |

### NFR
- 직교(orthogonality): transport=gRPC adapter only(domain unaware). provider-wiring 경로가 도메인 계층을 인지하지 않음 — 어댑터/설정 경계만 통과.

## 기타 UC FR

| UC | FR 위치 |
|----|---------|
| UC1 | `docs/progress/UC1-agent-horizontal-contract-2026-06-10.md` |
| UC5 | `docs/progress/UC5-agent-tool-loop-contract-2026-06-10.md` |
| UC-provider-provenance | `docs/progress/UC-provider-provenance-contract-2026-06-12.md` |
