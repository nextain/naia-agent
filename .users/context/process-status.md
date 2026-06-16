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

**이슈**: provider-wiring
**제목**: naia-os 전 프로바이더/모델 ↔ agent 연결 (정본 Option S: naia-settings 설정 기반 라이브 reload)
**이슈 문서**: [.agents/progress/new-naia-provider-wiring-2026-06-17.md](../progress/new-naia-provider-wiring-2026-06-17.md) (alpha-adk 루트)
**상태**: in_progress (2026-06-17)
**비고**: UC-memory(FR-MEM-1~10) 작업은 별도 — 미커밋 상태 유지(provider-provenance 동시작업 얽힘). 본 작업과 직교.

---

## SDLC 게이트

| 게이트 | 상태 | 산출물(deliverable) |
|--------|:----:|---------------------|
| P01 사용자시나리오 | done | docs/user-scenarios.md (UC-PROV-1) + 진행문서 |
| P02 테스트시나리오 | done | all-providers-wiring(9) + uc1-reload-default-config(3) + uc-naia-settings-store(19) + 프로세스 e2e 2종 |
| P03 요구사항 | done | docs/requirements.md (FR-PROV-1 config-first / FR-PROV-2 라이브 reload R1-2 / FR-PROV-3 native host-override gating) |
| P04 통합테스트 | done | 48 contract green + 프로세스 e2e 2종(config.json 로딩 / gRPC SetWorkspace→ReloadSettings 라이브 swap). 적대적 리뷰 통과(MEDIUM naiaGatewayUrl hijack 수정·잠금). |
| P05 완료 | in_progress | 코드+테스트 완료, 적대적 리뷰 통과. 커밋/푸시 후 사용자 실앱 테스트 대기(프론트엔드 rebuild 필요). |

마지막 업데이트: 2026-06-17

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
