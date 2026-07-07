---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: naia-agent 계보 분리 — 로컬 옛 packages/ 계보 vs origin/main = new-naia 재작성
date: 2026-07-07
status: investigation complete (루크 "먼저 더 조사" 응답) — 결정 대기
decision_needed: 벤치를 new-naia 로 포트할지 스코프
---

# naia-agent 계보 조사 (2026-07-07)

## 발단
"지금 개발한거 main브랜치에 머징" 지시가 계속 안 됨. push 가 `feat/humanlike-memory-bench`
로만 감. 원인 조사 → **로컬 main 과 origin/main 이 unrelated history**.

## 확정된 사실 (증거)
| | 로컬 main (+이번 세션 벤치) | origin/main |
|---|---|---|
| 구조 | 옛 **`packages/` 모노레포** | **new-naia 헥사고날 단일 `src/`** (`benchmark/`, `bin/`, `quarantine/`) |
| README/pkg | @nextain/agent-* 모노레포 | `@nextain/naia-agent` "뇌 런타임 + sub-agent 오케스트레이터(헥사고날)" |
| 커밋 | luke.yang, HL-1~selfspec (2026-07-04~07) | **luke_n_alpha, 2026-06-29~30**: persona 조립·workspace ctx·fs-tools·env-segments·memory sub-LLM·**UC-KNOWLEDGE(naia-kb-compiler 배선)** (#1) |
| 공통조상 | `origin/migration/slice-3-xr-compact`(77a355d)·`origin/backup/main-2026-06-22`(acf88e0) 와 **있음** | 옛 계보와 **없음** (fresh 재작성) |

**결론**: naia-agent 는 **2026-06-22 백업 → 06-29~30 헥사고날 재작성**으로 origin/main 을 교체함
([[project_new_naia_goal_and_method_anchor]] old→new 헥사고날 이식과 일치, 드리프트체크의
"new-naia-agent"). origin/main = **다른 프로젝트 아님, naia-agent 본체의 최신 재작성**.
- `origin/backup/main-2026-06-22` = **옛 계보(packages/)** 스냅샷 = 재작성 직전 백업.
- `origin/migration/*` = 옛 계보(Slice 3-XR) 브랜치들.
- ⚠ 초기 오독 정정: origin/main 을 "지식컴파일러 다른 프로젝트"로 봤으나, knowledge 는 재작성의
  한 기능(UC-KNOWLEDGE)일 뿐 프로젝트 정체는 naia-agent.

## 함의 — "main 머지 + 연동" = git merge 아니라 **포트**
- 이번 세션 벤치(HL-1~selfspec, 예측앵커)는 **재작성 이전 옛 packages/ 계보**에 얹혔다.
- origin/main(new-naia)에는 벤치 없음 + 아키텍처(헥사고날 단일 src)가 달라 코드 직접 이동 불가.
- naia-os(shell)가 spawn 하는 것도 **new-naia**(origin/main). 즉 실제 사용 경로는 재작성 쪽.

## 옵션 (루크 결정)
1. **문서(연구 결론)부터 포트** — SoT 앵커 + findings 는 계보 무관 → origin/main 에 markdown 이식.
   싸고 결론이 정본 레포에 남음. (추천: 지금)
2. **벤치 코드 포트** — 예측앵커·자아특이성 러너를 new-naia 헥사고날 메모리 포트에 재배선. 실
   엔지니어링, 별도 세션 규모. 선행 = new-naia 메모리 층이 옛 provider 와 같은지 확인.
3. **옛 계보 연구로 유지** — 현상 유지, 재작성 메모리 층 준비 후 포트.

## 현재 상태 (안전)
- 이번 세션 커밋 8건 옛 계보 로컬 main + 원격 `feat/humanlike-memory-bench`(c07b792 시점 push,
  이후 077f84c CHANGELOG 로컬). 빌드·벤치테스트 green. naia-os 연동 = stdio 사이드카(영향 없음).
- origin/main **미변경**(파괴 없음). 덮어쓰기 = 옛↔새 unrelated + 재작성 유실 위험이라 **안 함**.

## 확정 (2026-07-07 루크 확인)
- ⚠ 용어 정정: "new-naia" 아님. new-naia 는 이미 **정본 naia 로 통합**됨 → origin/main 이 그
  **정본 naia-agent**(헥사고날), 별도 프로젝트/별도 new-naia 아님.
- **결정적 증거**: 부모 `alpha-adk` 가 서브모듈 `projects/naia-agent` 를 **`7e67779`(=origin/main)**
  로 고정. 로컬 옛 main(077f84c, packages/)은 이 핀에 **없음**. naia-os 도 이 정본을 spawn.
- **루크 확인**: "구 naia 를 오히려 쓰지는 않아." → 옛 packages/ 계보 = 미사용(deprecated).
- **함의**: 이번 세션 벤치 코드는 미사용 옛 계보에 얹혔음. 유실 없음(원격 `feat/humanlike-memory-bench`
  + 로컬 브랜치 보존). durable 가치 = findings/SoT(계보 무관).

## 전환 실행 (2026-07-07, 루크 "전환 진행해")
- 옛 main(077f84c) → 로컬 브랜치 `old-packages-bench` 로 개명 보존(+원격 feat/humanlike-memory-bench).
- 로컬 `main` = origin/main(7e67779, 정본 헥사고날)로 전환 → 부모 핀과 일치.
- 이후: 정본 위에서 연구 findings/SoT 이식(옵션1) + 러너 포트 스코프(옵션2, 정본 메모리 층 확인 후).
