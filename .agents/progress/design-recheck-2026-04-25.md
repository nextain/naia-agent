# naia-agent 설계 재점검 — 2026-04-25

**Phase**: R0
**Master tracking issue**: nextain/naia-agent#2
**Plan file (오프라인)**: `~/.claude/plans/silly-exploring-sutherland.md`

---

## 1. Context — 왜 재점검?

이전 세션은 4-repo TDD rewind(Phase A/B/C)를 기계적으로 진행했지만, **실제 런타임 스켈레톤은 한 번도 동작한 적 없는 상태**(189 unit test green이지만 모든 `examples/*.ts`가 Mock + InMemory, `bin/naia-agent` 진입점 부재). 사용자가 순서가 뒤집혔다고 판단, 본 R0를 트리거함.

상위 핸드오프: `alpha-adk/.agents/progress/direction-2026-04-25.md`.

이번 세션 사용자 directive (누적):

1. 진행 상황은 **항상 GitHub 이슈로 추적** (가시성)
2. **구조·개발환경 먼저** 제대로
3. **설계부터 다시 점검** — 코드부터 손대지 말 것
4. **레퍼런스 검토 결정 누락 금지** — 7개 ref(+claude-code analysis) 결정 보존
5. **점진적 구동 + 테스트 가능** 상태 유지하며 개발 — 큰 덩어리 멈춤 금지

---

## 2. 기존 결정 — 보존만, 재결정 안 함

### 2.1 변경 금지 baseline

- **4-repo plan v7.2 Part A**: 정규 SoT. 본 R0는 Part A를 **수정하지 않는다**. 실행 시퀀싱만 변경.
- **`docs/agent-loop-design.md` D1~D8**: 변경 금지. R0는 새 결정 추가만.
- **`migration/phase-d` 브랜치 (Phase B + C.2 = 189 tests)**: PAUSED 유지. 본 R0는 건드리지 않음.

### 2.2 ref 채택 매트릭스로 통합

8개 ref reference (cline / jikime-adk / jikime-mem / moltbot / openclaw / opencode / project-airi / cc[private+cleanroom])의 모든 채택·거부·이연·drift·결정 누락 항목을 단일 매트릭스로 정리:

→ **`projects/naia-agent/.agents/progress/ref-adoption-matrix.md`**

매트릭스 §A(이미 채택, 15건), §B(거부, 16건), §C(이연, 22건), §D(R0 신규 채택 권고, 8건), §E(drift 위험, 8건), §F(결정 누락, 4건). 본 design-recheck는 매트릭스를 참조하며 새 항목 추가 시 매트릭스 ID(A##/B##/C##/D##/E##/F##) 인용.

### 2.3 ref별 review 파일

- `refs/cline-review.md` (commit 901d1b5c9, ★★)
- `refs/jikime-adk-review.md` (commit b9f4fb98, ★★)
- `refs/jikime-mem-review.md` (commit 0e3f6920, ★)
- `refs/moltbot-review.md` (commit f29e15c05d, ★)
- `refs/openclaw-review.md` (commit 8d85222, prior analysis baseline, ★★★)
- `refs/opencode-review.md` (commit 91468fe45, ★★★★★)
- `refs/project-airi-review.md` (commit 2b125d5f, ★★★★)
- `refs/cc-review.md` (private nextain/ref-cc + public ghuntley cleanroom, ★★★★★)

---

## 3. 새 원칙 — Progressive runnable + testable

이번 세션에 사용자가 명시적으로 추가한 다섯 번째 척도. 기존 issue #2의 4 audit (Context completeness / Methodology / Harness alignment / Reference adoption)에 더해진다.

### 3.1 슬라이스 success criterion (R1+ 적용 강제)

모든 슬라이스는 **다음 4가지 모두 만족** (생략 불가, 머지 차단):

1. **새 실행 가능 명령** — 사용자가 한 줄로 새 동작 호출 가능
2. **단위 테스트 1+** — vitest 실행, 회귀 잡힘
3. **통합 검증 1+** — fixture-replay OR real-LLM smoke (CI에서 KEY 있을 때만) OR 실 backend 호출
4. **README/CHANGELOG entry 1건** — 사용자 향한 변화 기록

### 3.2 현재 만족도

- 구동: **0/6** (zero consumer value beyond library import)
- 테스트: **2/6** (build + unit OK, integration/fixture/E2E 부재)
- 원칙 만족: ❌

상세: **`projects/naia-agent/.agents/progress/runnable-testable-gap.md`**

---

## 4. Gap inventory

상세: `runnable-testable-gap.md` §3.

### 4.1 P0 — 다음 슬라이스를 막음

- **G01**: `bin/naia-agent` 진입점 부재
- **G02**: 진짜 LLM × Agent 통합 검증 0건
- **G03**: DANGEROUS_COMMANDS regex 보안 필터 미존재 (D01)
- **G04**: Path normalization helper 미존재 (D02)
- **F01**: claude-code 15-agent 분석 결정 정식 매핑 부재 (본 design-recheck §2 + 매트릭스로 부분 해소)

### 4.2 P1 — 슬라이스 진행 중 함께

- **G05**: observability 패키지 단위 테스트 0개 (E02 sub)
- **G06**: Memory stubs 미구현 (E05) — issue #1 트래킹
- **G07**: Tool context 패턴 (D05)
- **G08**: Logger.tag/time 편의 (D06)
- **G09**: Compaction overflow + 동적 preserveRecent (D07)

### 4.3 P2 — 백로그

- **G10/G11/G12/G13/G14**: wLipSync viseme, fixture-replay framework, ChannelPlugin adapter, AuthManager 이벤트, Command Registry 카테고리

---

## 5. Slice spine — 헤드라인만 (R1 plan에서 상세화)

각 슬라이스는 §3.1 success criterion 4가지를 만족해야 한다.

| Slice | 목표 | 도입되는 갭 해소 | 새 실행 명령 후보 | 통합 검증 후보 |
|---|---|---|---|---|
| **0** (=R2) | 구조·개발환경 정비 | F01 부분 + R2 todo 전부 | (코드 0줄, 컨텍스트만) | docs link 검증 |
| **1** | `bin/naia-agent` 최소 REPL | G01, G02 | `pnpm exec naia-agent "hi"` | fixture-replay 첫 케이스 |
| **2** | bash skill + observability 보강 | G03, G04, G05 | `pnpm exec naia-agent ":bash ls"` | DANGEROUS regex 단위 + Logger.tag 단위 |
| **3** | alpha-memory 실 backend 통합 | G06 (issue #1 일부) | `pnpm exec naia-agent --memory=alpha "remember X"` | memory consolidate 호출 검증 |
| **4** | Compaction 동적 정책 | G07, G08, G09 | `pnpm exec naia-agent --long-session` | overflow trigger + preserveRecent 단위 |
| **5** | fixture-replay framework 정식 | G11 | `pnpm exec naia-agent --replay=path.json` | StreamRecorder/Player 단위 |

(**6** 이후는 Slice 1~5 검증 후 R1 plan에서 결정. naia-os agent/ 마이그레이션 슬라이스(R3+ 별도 plan)는 본 척추와 별개.)

⚠️ **Slice 6 이후는 R1에서 정한다.** 본 R0 산출물에는 헤드라인만.

---

## 6. Structure / dev env todo (R2 입력)

R2 별도 plan으로 실행. 본 R0는 인벤토리만:

| # | 항목 | 우선순위 | 비고 |
|---|---|:---:|---|
| S01 | `projects/naia-agent/AGENTS.md` 신설 | **P0** | R0.8에서 본 plan 내 처리 |
| S02 | `projects/naia-agent/CLAUDE.md` 신설 | **P0** | R0.8에서 처리 |
| S03 | `projects/naia-agent/.agents/context/agents-rules.json` 신설 | **P0** | R0.8에서 처리 |
| S04 | `projects/naia-agent/.agents/context/project-index.yaml` 신설 | **P0** | R0.8에서 처리 |
| S05 | `.github/CODEOWNERS` 신설 | P1 | naia-os 본보기 따라가기. R2 |
| S06 | PR template 정합성 검증 (migration/* prefix, A.7) | P1 | R2 |
| S07 | `.users/` 미러 (English default per A.11) | P2 | R2 또는 백로그 |
| S08 | hooks 결정 (PostToolUse 등 jikime-adk 패턴 검토) | P2 | R3+ |
| S09 | `package.json` script 보강 (smoke:real-agent 추가) | P1 | Slice 1 도중 |
| S10 | CHANGELOG 슬라이스 섹션 포맷 정립 | P1 | Slice 1 도중 |

R0.8에서 S01~S04 즉시 처리(P0). S05 이후는 R2 plan에서.

---

## 7. P0 / P1 / P2 종합 라벨

본 design-recheck의 라벨 정의:

- **P0** (R1 시작을 막음, sub-issue 필수): G01, G02, G03, G04, F01, S01, S02, S03, S04
- **P1** (R1 시작 전 권장, sub-issue 권장): G05, G06, G07, G08, G09, S05, S06, S09, S10
- **P2** (이연 가능, 본 문서에만 기록): G10~G14, S07, S08

P0 sub-issue는 R0.7에서 일괄 생성, `#2` body 체크리스트에 추가.

---

## 8. R0 종료 후 진입 조건 (R1 plan 작성 전제)

다음 모두 충족 시 R1 작성 시작:

- [ ] 8개 `refs/{name}-review.md` 존재 (✅ 완료)
- [ ] `ref-adoption-matrix.md` 존재 + §A~F 통합 (✅ 완료)
- [ ] `runnable-testable-gap.md` 존재 (✅ 완료)
- [ ] 본 design-recheck 존재 (✅ 완료 — 본 파일)
- [ ] P0 sub-issue ≥ 1개 OPEN (R0.7에서 처리)
- [ ] `AGENTS.md` / `CLAUDE.md` / `.agents/context/{agents-rules.json, project-index.yaml}` 존재 (R0.8에서 처리)
- [ ] `git diff --name-only packages/` = 빈 결과 (R0는 코드 무수정 — 자동 만족)

R1 plan 위치: 본 R0 종료 후 `~/.claude/plans/`에 새 plan 파일.

---

## 9. 본 R0가 의도적으로 다루지 않는 것

- `bin/naia-agent` 스켈레톤 (R3+)
- npm publish (무기한 이연)
- Phase B/C TDD rewind 재개 (스켈레톤 운행 후)
- naia-os agent/ 마이그레이션 슬라이스 (R3+)
- alpha-adk 서브모듈 포인터 bump (R0 전체 종료 후 별도 commit)
- 4-repo plan v7.2 Part A 수정 (실행 시퀀싱만 변경, 원칙 변경 아님)
- claude-code 옛 npm 버전(1.0.x) 재추출 시도 (사용자 판단: "유출 npm은 삭제했겠")

---

## 10. 참고 — R0 산출물 인덱스

```
projects/naia-agent/
├── .agents/
│   ├── context/                           # R0.8에서 신설
│   │   ├── agents-rules.json              # P0
│   │   └── project-index.yaml             # P0
│   └── progress/                          # 본 R0 산출물
│       ├── design-recheck-2026-04-25.md   # 본 파일 (메인)
│       ├── ref-adoption-matrix.md         # 매트릭스
│       ├── runnable-testable-gap.md       # 갭
│       └── refs/                          # 8개 ref review
│           ├── cline-review.md
│           ├── jikime-adk-review.md
│           ├── jikime-mem-review.md
│           ├── moltbot-review.md
│           ├── openclaw-review.md
│           ├── opencode-review.md
│           ├── project-airi-review.md
│           └── cc-review.md
├── AGENTS.md                              # R0.8에서 신설 (P0)
├── CLAUDE.md                              # R0.8에서 신설 (P0)
└── (기타 unchanged)
```

GitHub:
- `nextain/naia-agent#2` — 마스터 트래킹 (R0.2 댓글 추가 완료)
- `nextain/naia-agent#1` — Test coverage audit (PAUSED, 본 R0와 별개)
- `nextain/naia-agent#?+` — R0.7에서 P0 sub-issue ~5건 생성 예정

비공개 자산:
- `nextain/ref-cc` (private repo) — 분석 docs 전용
- `projects/refs/ref-cc` submodule pointer
- `projects/refs/ref-cc-cleanroom` submodule (public ghuntley)
