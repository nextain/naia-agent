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

**이슈**: UC-memory
**제목**: naia-memory 연동(턴 전 recall 주입 / 턴 후 save)
**이슈 문서**: [docs/progress/UC-memory-recall-save-contract-2026-06-12.md](../../docs/progress/UC-memory-recall-save-contract-2026-06-12.md)
**상태**: in_progress (2026-06-12)

---

## SDLC 게이트

| 게이트 | 상태 | 산출물(deliverable) |
|--------|:----:|---------------------|
| P01 사용자시나리오 | done | docs/user-scenarios.md (UC-MEM-1) |
| P02 테스트시나리오 | done | uc1-memory-stdio/process integration tests |
| P03 요구사항 | done | docs/requirements.md (FR-MEM-1~8 + NFR) |
| P04 통합테스트 | done | 통합테스트 14+1건 통과 |
| P05 완료 | in_progress | FR-MEM-1~10 Done(232 테스트 green). 코드 2-clean 완료. 설계 리뷰 25라운드 반영; 설계 2-clean 최종 확인은 codex usage-limit(06-13 02:10 리셋)로 보류. 미커밋(동시작업 얽힘). |

마지막 업데이트: 2026-06-12

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
