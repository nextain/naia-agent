# naia-agent

4-repo Naia 생태계의 **허브 런타임** 패키지.

| 레포 | 역할 |
|---|---|
| `naia-os` | Host (Tauri shell + 3D avatar + OS 이미지) |
| **`naia-agent`** (이 레포) | Runtime 엔진 + 공개 인터페이스 SoT |
| `naia-adk` | 워크스페이스 포맷 + 스킬 표준 (`@naia-adk/skill-spec`) |
| `alpha-memory` | MemoryProvider 레퍼런스 구현 |

원칙: **Interfaces, not dependencies** — 공개 인터페이스로만 결합, 런타임 결합 금지. 호스트가 구현체 주입.

## 진입점 — 무엇을 먼저 읽을까

코드를 만지기 전에 다음 순서로 읽어라. **순서 중요**:

1. **현 진행 상태**: `.agents/progress/design-recheck-2026-04-25.md` (Phase R0 메인 산출물 — 어디까지 결정됐고 어디부터 진행하는지)
2. **레퍼런스 채택**: `.agents/progress/ref-adoption-matrix.md` (8개 ref + claude-code 분석에서 도출된 채택/거부/이연 단일 매트릭스)
3. **갭 분석**: `.agents/progress/runnable-testable-gap.md` (현 표면 vs 점진적 구동+테스트 원칙 만족도)
4. **상위 plan**: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (4-repo plan v7.2 Part A — 본 레포는 Part A의 Runtime 엔진 + Interface SoT)
5. **상위 directive**: `alpha-adk/.agents/progress/direction-2026-04-25.md` (이번 R0를 트리거한 사용자 directive)

## 아키텍처 / 계약 / 호스팅 가이드

다음 3개는 R0 이전 작성된 정규 문서. R0는 이를 **수정하지 않는다**.

- `docs/ARCHITECTURE.md` — 전체 아키텍처 + 패키지 맵
- `docs/agent-loop-design.md` — Agent 루프 D1~D8 결정 (수정 금지, 신규 결정만 매트릭스 §D 추가)
- `docs/hosting-guide.md` — 임베드 가이드 (5분~20분)
- `docs/memory-provider-audit.md` — 메모리 façade 감사
- `docs/voice-pipeline-audit.md` — 음성 파이프라인 감사 (Option C 결정)

## 작업 규칙 (R0/R1 단계 강제)

### 코드 변경 전 필수

1. 본 README + design-recheck를 먼저 읽었는가?
2. 변경하려는 패턴이 매트릭스 §A(이미 채택)에 있다면 추가 결정 없이 그대로 따른다.
3. 매트릭스 §B(거부)에 있는 것을 도입하려 한다면 **별도 ADR 작성** + 사용자 승인.
4. 매트릭스에 없는 패턴을 새로 도입한다면 매트릭스 §D에 항목 추가 + sub-issue 생성.

### 슬라이스 success criterion (R1+ 강제)

모든 슬라이스 PR은 다음 4가지 모두 만족:

1. 새 실행 가능 명령 (`pnpm exec naia-agent ...`)
2. 단위 테스트 1+
3. 통합 검증 1+ (fixture-replay or real-LLM smoke or 실 backend 호출)
4. README/CHANGELOG entry 1건

(c) 통합 검증 부재 슬라이스는 머지 차단.

### 절대 금지

- `migration/phase-d` 브랜치 변경 (Phase B + C.2 = 189 unit test, PAUSED 상태 유지)
- `docs/agent-loop-design.md` D1~D8 변경 (보존)
- 4-repo plan v7.2 Part A 수정 (실행 시퀀싱만 변경 가능, 원칙 변경은 새 plan 버전 필요)
- `bin/naia-agent` 스켈레톤 미존재 상태에서 `examples/` 외 복잡한 코드 추가 (R3+까지 Slice 외 코드 변경 금지)

## 진행 트래킹

- **마스터 이슈**: nextain/naia-agent#2 — design review (R0 트래킹 본거지)
- **테스트 커버리지 audit**: nextain/naia-agent#1 (PAUSED, R0와 별개)
- **R0 sub-issues**: #3 (G01), #4 (G02), #5 (G03+G04), #6 (F01), #7 (P1 클러스터)

## Claude Code 사용자

`CLAUDE.md` 추가 규칙 참조.
