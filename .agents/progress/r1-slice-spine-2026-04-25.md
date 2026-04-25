# R1 — Slice Spine (정밀화)

**Phase**: R1
**Created**: 2026-04-25
**Master tracking**: nextain/naia-agent#2
**Inputs**: `design-recheck-2026-04-25.md` §5 (slice spine outline) + `runnable-testable-gap.md` §3 (P0/P1/P2 갭) + `ref-adoption-matrix.md` (§D 신규 채택 권고)

---

## 0. 본 R1의 범위

R0가 "무엇을 결정했는가"라면, R1은 "그 결정을 어떻게 슬라이스 단위로 실행할 것인가"를 정한다. 본 R1 plan **자체는 코드 0줄** — 슬라이스 척추 표 + 각 슬라이스 정의만. 코드 진입은 R2(Slice 0) 이후.

R0와 동일 원칙 유지:

- 매 슬라이스 = 새 실행 가능 명령 + 단위 테스트 1+ + 통합 검증 1+ + README/CHANGELOG entry
- 통합 검증 부재 슬라이스 머지 차단
- 매트릭스 ID 인용 (G##/D##/E## 등)

---

## 1. Slice naming + branch convention

```
migration/slice-{N}-{kebab-summary}
```

예:
- `migration/slice-0-structure-devenv` (R2)
- `migration/slice-1-bin-naia-agent`
- `migration/slice-2-bash-skill-obs`
- `migration/slice-3-alpha-memory-real`
- `migration/slice-4-compaction-dynamic`
- `migration/slice-5-fixture-replay-framework`

4-repo plan A.7(`migration/*` prefix) 규약 유지. 1인 개발 환경에서 PR 머지 후 24h 관찰 권장 (A.7 self-discipline).

---

## 2. Slice 의존성 그래프

```
Slice 0 (R2) ──→ Slice 1 ──→ Slice 2 ──→ Slice 3 ──→ Slice 4 ──→ Slice 5
                              ↑              ↑
                         (G05 obs        (G09 com-
                         이 같이)          paction
                                          여기서)
```

**규칙**:
- 직선 의존 (skip 금지) — 각 슬라이스가 이전 슬라이스 산출물 위에 build
- 단, **Slice 0(R2)는 Slice 1과 병행 가능** — 구조·문서 작업이 코드 작업과 충돌 없음
- Slice 4 (compaction)는 Slice 1+2 충분히 안정 후 진행 (compaction은 long-session 시나리오 필요)

---

## 3. Slice 0 — Structure / Dev env (R2)

### 3.1 목표

R0.8에서 미처리한 구조·개발환경 항목 일괄 정비. 코드 변경 0줄. 외부 contributor가 진입할 때 막힘 없도록.

### 3.2 Branch / PR

- branch: `migration/slice-0-structure-devenv`
- PR 단위 1개. 모든 항목 묶어서.

### 3.3 산출 파일

| 파일 | 작업 | 출처 매트릭스 |
|---|---|---|
| `.github/CODEOWNERS` | 신설 (naia-os 본보기) | S05 |
| `.github/PULL_REQUEST_TEMPLATE.md` | migration/* prefix 체크박스 추가 (A.7) | S06 |
| `.users/` 디렉터리 | English 미러 (P2이지만 같이 처리 — 프로젝트 자체가 English-default per plan A.11) | S07 |
| `package.json` `scripts` | `smoke:real-agent` 신규 추가 (Slice 1 진입 준비) | S09 |
| `CHANGELOG.md` | "Unreleased" 섹션 + Slice 단위 entry 포맷 정립 | S10 |
| `README.md` | Slice spine 링크 추가 (본 r1 plan 가리킴) | — |

### 3.4 Success criterion (4가지)

1. **새 실행 가능 명령**: `pnpm run smoke:real-agent` (Slice 1 placeholder — `echo "skeleton not yet implemented" && exit 0`)
2. **단위 테스트**: docs link 검증 (예: `node scripts/verify-docs-links.ts`) — 깨진 링크 없는지 1건
3. **통합 검증**: CODEOWNERS 문법 valid (`gh api repos/{owner}/{repo}/codeowners/errors`)
4. **README/CHANGELOG entry**: "Slice 0 - Structure/Dev env"

### 3.5 Sub-issue

- #7 P1 클러스터의 S05/S06/S09/S10 항목

---

## 4. Slice 1 — `bin/naia-agent` 최소 REPL (v2: 1a/1b 분할)

> **v2 변경 (2026-04-25 cross-review)**: Slice 1을 1a(mock-only) / 1b(real Anthropic + fixture) 두 PR로 분할. 위험 격리 — 1b 실패 시 1a로 rollback 가능. 척추(bin) 1a에서 살아남으면 F01 자동 해제.

### 4.0 Slice 1a — bin skeleton (mock-only)

- **branch**: `migration/slice-1a-bin-skeleton`
- **목표**: `bin/naia-agent.ts` + host factory + mock LLM 단위 테스트만. real-API 통합 없음. F01 자동 해제 trigger
- **산출**:
  - `bin/naia-agent.ts` (readline REPL + stdin/args 분기)
  - `package.json` `bin` 필드 + `scripts.naia-agent:dev`
  - `examples/real-anthropic-host.ts` 골격 (config만, 실제 호출 1b로)
  - `__tests__/bin-naia-agent.test.ts` (host factory 단위 검증, mock LLM)
- **success criterion**:
  1. `pnpm exec naia-agent "hi"` (mock 모드) 동작
  2. `bin-naia-agent.test.ts` 단위 테스트 1+
  3. `examples/minimal-host.ts` 회귀 (mock smoke)
  4. CHANGELOG "Slice 1a" entry
- **매트릭스 영향**: G01 해소, F01 자동 해제 trigger

### 4.1 Slice 1b — real Anthropic + ad-hoc fixture-replay

- **branch**: `migration/slice-1b-real-anthropic`
- **목표**: 1a host factory에 real AnthropicClient 주입. fixture-replay 1건. **D09 (workspace sentinel) + D10 (Tool 메타) 동시 ingrain (P0)**.
- **산출**:
  - 1a에 real Anthropic 모드 추가 (env `ANTHROPIC_API_KEY` 검출)
  - `__fixtures__/anthropic-1turn.json` (녹화)
  - `__tests__/fixture-replay.test.ts`
  - **D09**: `packages/runtime/src/utils/path-normalize.ts` 신설 (sentinel `startsWith(root + sep)`)
  - **D10**: `packages/types/src/tool.ts` Tool 메타 필드 추가 (`isConcurrencySafe?`, `isDestructive?`, `searchHint?`, `contextSchema?`)
  - **D11 부분 (Tool context schema)**: ToolExecutionContext에 sessionId/dir/abort 필드
- **success criterion**:
  1. `pnpm exec naia-agent "hi"` 실 Anthropic 호출 → answer
  2. `fixture-replay.test.ts` PASS (G02 해소)
  3. `pnpm run smoke:real-agent` (CI conditional, KEY 있을 때만)
  4. CHANGELOG "Slice 1b" entry + D09/D10/D11 §A 승격 표기
- **매트릭스 영향**: G02 해소, D09/D10/D11 §C → §D → §A 승격

### 4.2 (구) 4.1~4.7 — 1a/1b 통합 정의 (보존, 참고용)

원래 단일 Slice 1 정의는 위 1a + 1b로 분할. 단일 PR로 진행하려면 4.0 + 4.1을 묶을 수 있음 (단 위험 격리 효과 사라짐).

(원래 §4.1~§4.7 보존 — 구체 산출 항목 통합):

### 4.2 Branch / PR

- branch: `migration/slice-1-bin-naia-agent`
- PR 단위 1개

### 4.3 산출 파일

| 파일 | 작업 |
|---|---|
| `bin/naia-agent.ts` | 신설 — readline REPL + non-TTY stdin/args 지원 |
| `package.json` | `bin` 필드 추가: `"naia-agent": "./bin/naia-agent.ts"` |
| `package.json` `scripts` | `naia-agent:dev: tsx bin/naia-agent.ts` |
| `examples/real-anthropic-host.ts` | 신설 — `bin/naia-agent.ts` 골격의 라이브러리 형태 (재사용 가능 host factory) |
| `__tests__/bin-naia-agent.test.ts` | 단위 테스트 — host factory 분리 검증 |
| `__tests__/fixture-replay.test.ts` | fixture-replay 1건 — Anthropic SDK 스트림 녹화 JSON → Agent 결정적 재생 |
| `__fixtures__/anthropic-1turn.json` | 녹화된 fixture (1턴 hello/world) |
| `CHANGELOG.md` | Slice 1 entry |

### 4.4 Success criterion

1. **새 실행 가능 명령**:
   - `pnpm exec naia-agent "hello"` → Anthropic Haiku 호출 → 답 stdout
   - `echo "hello" | pnpm exec naia-agent` (stdin)
   - `pnpm exec naia-agent` (no args → REPL 모드)
2. **단위 테스트**: `bin-naia-agent.test.ts` — host factory가 mock LLM에서 정상 동작 (1+ test)
3. **통합 검증**: `fixture-replay.test.ts` — Anthropic SDK 스트림 fixture 재생 시 assistantText 결정적 (G02 해소)
4. **README/CHANGELOG entry**: "Slice 1 - bin/naia-agent minimal REPL"

### 4.5 도입되는 매트릭스 항목

- **G01**: bin 진입점 — 해소
- **G02**: real-LLM 통합 검증 — fixture-replay로 해소
- **G07**: Tool context 패턴 (sessionID/directory/ask) — host factory에서 시작
- **D05**: Tool context (opencode 출처) — 도입
- **F08**: bin 미존재 시 코드 변경 차단 (agents-rules.json) — bin 도입으로 자동 해제

### 4.6 Sub-issues

- #3 (G01)
- #4 (G02)
- #7 일부 (G07)

### 4.7 의도적으로 하지 않는 것

- 진짜 도구 실행 (Slice 2)
- 진짜 alpha-memory (Slice 3)
- 동적 compaction (Slice 4)
- 정식 fixture-replay framework (Slice 5 — 본 슬라이스에서는 ad-hoc)

---

## 5. Slice 2 — Bash skill + observability 보강

### 5.1 목표

bin이 진짜 도구를 호출할 수 있게. 보안 + observability 같이 들어감. (cleanroom-cc 영향 핵심 지점)

### 5.2 Branch / PR

- branch: `migration/slice-2-bash-skill-obs`
- PR 단위 1개

### 5.3 산출 파일

| 파일 | 작업 |
|---|---|
| `packages/runtime/src/skills/bash.ts` | 신설 — Bash 실행 skill (DANGEROUS_COMMANDS regex 통합) |
| `packages/runtime/src/utils/path-normalize.ts` | 신설 — Path normalization helper |
| `packages/runtime/src/__tests__/bash-skill.test.ts` | 단위 테스트 — regex 매칭/통과 케이스 12+ |
| `packages/runtime/src/__tests__/path-normalize.test.ts` | 단위 테스트 — traversal 차단 4+ |
| `packages/observability/src/__tests__/console-logger.test.ts` | 신설 — G05 obs 단위 테스트 |
| `packages/observability/src/__tests__/in-memory-meter.test.ts` | 신설 |
| `packages/observability/src/__tests__/noop-tracer.test.ts` | 신설 |
| `packages/observability/src/logger.ts` | `tag()` + `time()` 메서드 추가 (D06) |
| `examples/bash-skill-host.ts` | 신설 — bash skill 사용 예 |
| `CHANGELOG.md` | Slice 2 entry |

### 5.4 Success criterion

1. **새 실행 가능 명령**: `pnpm exec naia-agent ":bash ls"` (slash command 형태로 bash 직접 호출)
2. **단위 테스트**: 4개 새 test file (bash-skill, path-normalize, 3개 obs)
3. **통합 검증**: `examples/bash-skill-host.ts`가 실제 `ls` 실행하고 결과 capture
4. **README/CHANGELOG entry**: "Slice 2 - Bash skill + observability"

### 5.5 도입되는 매트릭스 항목

- **G03**: DANGEROUS_COMMANDS — 해소
- **G04**: Path normalization — 해소
- **G05**: observability 단위 테스트 — 해소
- **G08**: Logger.tag/time — 해소
- **D01/D02/D06**: cleanroom-cc + opencode 권고 — 도입

### 5.6 Sub-issues

- #5 (G03+G04)
- #7 일부 (G05/G08)

---

## 6. Slice 3 — alpha-memory 실 backend 통합

### 6.1 목표

`bin/naia-agent --memory=alpha`가 실제 alpha-memory와 통신. encode/recall/consolidate 검증.

### 6.2 Branch / PR

- branch: `migration/slice-3-alpha-memory-real`

### 6.3 산출 파일

| 파일 | 작업 |
|---|---|
| `examples/alpha-memory-host.ts` | **수정** — Mock LLM을 real Anthropic으로 (현재 mock LLM + real memory) |
| `bin/naia-agent.ts` | `--memory=<adapter>` 플래그 추가 |
| `__tests__/alpha-memory-integration.test.ts` | 통합 검증 — real alpha-memory consolidate 호출 verify |
| `CHANGELOG.md` | Slice 3 entry |

### 6.4 Success criterion

1. **새 실행 가능 명령**: `pnpm exec naia-agent --memory=alpha "remember X"` → 다음 호출에서 X 회상
2. **단위 테스트**: 어댑터 시그니처 검증
3. **통합 검증**: 실제 alpha-memory 호출 → consolidate 실행 → recall 가능
4. **README/CHANGELOG entry**: "Slice 3 - alpha-memory backend"

### 6.5 도입되는 매트릭스 항목

- **G06**: Memory stubs — 일부 해소 (issue #1과 cross-link). **v2: cross-repo P0 gate 명시** — alpha-memory 측에서 stub 해소되기 전 Slice 3 진입 차단
- **E05/E07**: Memory silent data-loss / 양방향성 시점 — 결정 강제

### 6.6 의존 (v2 강화)

**Cross-repo P0 gate**: alpha-memory의 stub 구현(`contentTokens`, `jaccardSimilarity`, `mergeRelatedFacts`)이 issue #1에서 해소되기 **전에는 Slice 3 진입 금지**. alpha-memory PR이 stub branch dead code 제거 + warn emit (F10) 추가 후 본 슬라이스 진입.

---

## 7. Slice 4 — Compaction 동적 정책

### 7.1 목표

Long-session 시나리오에서 compaction이 자동 발동하고 dropped count emit.

### 7.2 Branch / PR

- branch: `migration/slice-4-compaction-dynamic`

### 7.3 산출 파일

| 파일 | 작업 |
|---|---|
| `packages/core/src/agent.ts` | `maybeCompact` overflow 검사 + 동적 preserveRecent (D07) |
| `packages/core/src/__tests__/compaction-dynamic.test.ts` | 단위 테스트 — 트리거/스킵 케이스 |
| `examples/long-session-host.ts` | 신설 — 100+ 턴 시뮬레이션 |
| `__tests__/long-session-fixture-replay.test.ts` | 통합 검증 — fixture로 long-session 재생 → compaction emit verify |
| `CHANGELOG.md` |

### 7.4 Success criterion

1. **새 실행 가능 명령**: `pnpm exec naia-agent --long-session-demo` (스크립트된 100턴 fixture)
2. **단위 테스트**: compaction 트리거/스킵
3. **통합 검증**: fixture-replay long-session → 정확한 시점에 `compaction` event emit
4. **README/CHANGELOG entry**: "Slice 4 - Dynamic compaction"

### 7.5 도입되는 매트릭스 항목

- **G09**: Compaction overflow + 동적 preserveRecent — 해소
- **D07**: opencode 영향 — 도입

---

## 8. Slice 5 — Fixture-replay framework 정식

### 8.1 목표

Slice 1+4에서 ad-hoc 도입한 fixture-replay를 정식 framework로 격상. `StreamRecorder` + `StreamPlayer` 표준화.

### 8.2 Branch / PR

- branch: `migration/slice-5-fixture-replay-framework`

### 8.3 산출 파일

| 파일 | 작업 |
|---|---|
| `packages/testing/src/index.ts` | **신설 패키지** `@nextain/agent-testing` (계약: P0이면 R0 매트릭스에 추가, 현재는 권고) |
| `packages/testing/src/stream-recorder.ts` | record real Anthropic SDK stream → JSON |
| `packages/testing/src/stream-player.ts` | replay JSON → AsyncIterable<Chunk> |
| `packages/testing/src/__tests__/recorder.test.ts` | 단위 |
| `packages/testing/src/__tests__/player.test.ts` | 단위 |
| `examples/fixture-replay-host.ts` | record + replay 데모 |
| `__tests__/cross-slice-replay.test.ts` | 통합 — 다른 슬라이스의 fixture를 player로 재생 |

### 8.4 Success criterion

1. **새 실행 가능 명령**: `pnpm exec naia-agent --replay=path.json`
2. **단위 테스트**: recorder/player
3. **통합 검증**: 기존 슬라이스(Slice 1) fixture를 player로 재생 → 동일 결과
4. **README/CHANGELOG entry**: "Slice 5 - Fixture replay framework"

### 8.5 도입되는 매트릭스 항목

- **G11**: fixture-replay framework — 해소
- **C21**: 이연(C) → 채택(A) 승격

### 8.6 의존

- Slice 1 (ad-hoc replay 존재)
- Slice 4 (long-session fixture)

---

## 9. R1 종료 조건 + R3+ 진입

본 R1 plan은 **slice spine 표만 정의**. R1 plan 자체에 코드 0줄.

R1 plan 머지 후:
1. **R2 (Slice 0) 진입** — 구조·개발환경 정비 PR
2. R2 머지 후 **R3 (Slice 1) 진입** — bin/naia-agent
3. 이후 Slice 2 → 3 → 4 → 5 순차

각 Slice 진입 시 별도 plan 또는 본 R1 plan의 해당 §를 참조 (작은 슬라이스는 별도 plan 불필요).

---

## 9.5 R3+ Slice outline (v2 신규, 2026-04-25 cross-review)

본 R1 plan 종료(Slice 5 머지) 후 R2 plan에서 정식화할 슬라이스 후보. 코드 0줄, 헤드라인만:

- **R3.1 Eval scorers slice** — Mastra `MastraScorer` 패턴, **D14**. fixture-replay + scorer 묶어 quality 회귀 잡기
- **R3.2 Tool 메타 + 3중 Context 정형화** — D10/D11/D13 정식 framework
- **R3.3 Hook 28-event spec** — claude-code 분석 + jikime-adk 패턴 + cleanroom register.ts
- **R3.4 Task framework** — Mastra workflow + Vercel WDK suspend/resume
- **R3.5 naia-os sidecar 통합** — 4-repo 합체, naia-os shell이 naia-agent CLI를 child process로

R3+ slice 진입 조건: R1 Slice 5 머지 + 매트릭스 §C/§D 항목 충족 + 사용자 directive.

## 10. 슬라이스 외 작업 (병행 가능)

본 척추와 별개로 진행 가능한 트랙:

| 트랙 | 책임 | 비고 |
|---|---|---|
| naia-os agent/ 마이그레이션 (X1 슬라이스 후속) | naia-os 별도 plan | 본 R1 척추와 독립 |
| alpha-memory benchmark | alpha-memory 별도 세션 | 본 척추와 독립 |
| issue #1 test coverage audit (Phase B/C/D rewind 일부) | naia-agent 별도 PR | PAUSED 상태이지만 G06 해소에 도움 |

위 3개는 슬라이스 진행 중에도 별개 PR로 머지 가능. 단 naia-agent의 핵심 척추(슬라이스 1~5)와는 분리.

---

## 11. 정의된 매트릭스 ID — R1 진입 후 변동

R1 plan 자체는 매트릭스 변경하지 않음. 하지만 다음 ID들이 슬라이스 진행 중 매트릭스에서 이동 예상:

- **§C → §A 승격 후보**: D01, D02, D05, D06, D07, C21 → 슬라이스 머지 시점에 §A로 이동
- **§E drift → §A 해소**: E04 (Agent-level smoke 미존재) → Slice 1에서 해소
- **§F → §A**: F01 → #6 close 시 (cross-link 추가만 잔여)

매트릭스 업데이트는 각 슬라이스 PR 마지막 단계에서 같이.

---

## 12. 중단 조건 (R1 abort)

본 plan을 중단하고 재설계 트리거:

- **Slice 1 실패**: bin/naia-agent가 real Anthropic 통합에서 막힘. fixture-replay도 안 되면 → Phase 0 재진입
- **A.3 의존 방향 위배**: Slice 1+ 진행 중 zero-runtime-dep 원칙 깨짐 발견 → 매트릭스 §A 항목 재검토
- **사용자 directive 변경**: "점진적 구동+테스트" 원칙 자체 변경 → R0 재진입

---

## 부록 A — 슬라이스 PR 체크리스트 템플릿

매 슬라이스 PR description에 다음 체크리스트 포함:

```markdown
## Slice {N} — {summary}

### Success criterion
- [ ] 새 실행 가능 명령: `<command>`
- [ ] 단위 테스트: {file}, {count} cases
- [ ] 통합 검증: {fixture-replay or real-LLM smoke or backend call}
- [ ] README/CHANGELOG entry

### 매트릭스 영향
- 해소: {G##/D##/E## list}
- §C → §A 승격: {ID list}
- 신규 §D 추가: {ID list, 있으면}

### 차단 검증
- [ ] migration/* branch prefix
- [ ] 24h 관찰 기간 (1인 self-discipline, A.7)
- [ ] PAUSED 자산 무손상 (migration/phase-d, agent-loop-design D1~D8, 4-repo plan Part A)

### Sub-issue close
- closes #?
```

---

## 부록 B — 본 R1과 R0의 산출물 비교

| 항목 | R0 | R1 |
|---|---|---|
| 코드 변경 | 0줄 | 0줄 (본 plan) |
| 산출물 | 매트릭스 + 갭 + design-recheck + 8 reviews + 컨텍스트 | 본 r1-slice-spine |
| 결정 | 채택/거부/이연 | 슬라이스 단위 실행 순서 |
| 다음 단계 | R1 plan | R2(Slice 0) PR |
| Sub-issue | 4 P0 + 1 P1 cluster (#3~#7) | 슬라이스마다 PR로 close |
