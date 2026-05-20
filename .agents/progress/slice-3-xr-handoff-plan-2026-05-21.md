# Slice 3-XR-Handoff — cross-session handoff with auto-trigger (2026-05-21)

**상태**: PLAN — 사용자 directive ("naia-agent의 핸드오프도 개발해야지 / 컨텍스트가 일정 이상 차면 진행하게 테스트 루프 만들어서 진행").
**선행 완료**: Slice 3-XR-Compact (#47, merged 2026-05-21) — `naia-memory.compact()` v3 anchored iterative + 5-section markdown recap.
**Issue**: nextain/naia-agent#50.

---

## 1. 동기

Slice 3-XR-Compact = **in-session** context shrinking. naia-os avatar 의 long-running dialog 는 cross-session — 매일 reboot, 명시 "new chat", 다일 대화. handoff 없으면 새 session 마다 blind.

- **Compaction** = in-session knob (token budget 75%, head → recap, in-place 교체)
- **Handoff** = **cross-session knob** (세션 종료 / 명시 `/handoff` / budget 95% post-compact, 전체 session → blob, 새 session 의 first system/user 주입)

본 slice 의 **핵심 사용자 요청** = "**컨텍스트 일정 차면 자동 진행 테스트 루프**" — auto-trigger 가 작동하는지 mock LLM 으로 reproducible 검증.

---

## 2. 디자인 결정

### 2.1 HandoffBlob schema

```typescript
interface HandoffBlob {
  /** Schema version for forward-compat */
  readonly version: 1;
  /** Originating session ID */
  readonly sessionId: string;
  readonly createdAt: number;
  /** Total turns in source session */
  readonly turnCount: number;
  /** Approximate total tokens (chars/4) */
  readonly totalTokens: number;
  /** Trigger that produced this blob */
  readonly trigger: "manual" | "budget-95-post-compact" | "session-close" | "idle-timeout";
  /** The recap message — produced by naia-memory.compact() with keepTail=0 */
  readonly recap: CompactionMessage;
  /** Strict-preserved identifier anchors (UUID/URL/file path verbatim) */
  readonly anchors: readonly string[];
}
```

### 2.2 Auto-trigger threshold

| Trigger | When | Logic |
|---|---|---|
| **manual** | User invokes `/handoff` OR bin `--handoff-out <path>` | Force export at session end. |
| **budget-95-post-compact** | `estimateTokens(request) > contextBudget * 0.95` AND `#compactedThisSession === true` | Compaction couldn't shrink enough — escalate to handoff. |
| **session-close** | Normal session end + `autoExport: true` | Always emit blob for next session. |
| **idle-timeout** | (deferred to follow-up) | N minutes silence. |

**Why post-compact (not pre)**: compaction 이 cheaper. handoff 는 disruptive (새 session 시작 의미). 항상 compaction 먼저, 그래도 한계 시만 handoff.

### 2.3 Blob format

**JSON wrapping markdown recap** — typed metadata 가 outside (turnCount, anchors, trigger), free-text recap content 가 inside `.recap.content`. naia-os 가 reviewable + machine 가 typed.

### 2.4 Identifier anchors

`recap.content` 가 5-section markdown 의 `## Relevant files / URLs` section + `## Tool calls made` 의 identifier 들을 가짐. blob 의 별도 `anchors: string[]` = 그 union deduped. 새 session import 시 system prompt 에 "Known identifiers from prior session: ..." 로 명시 주입 (fact-level recall ↑).

### 2.5 Persistence

- **File mode** (`--handoff-out <path>`, `--handoff-in <path>`): JSON 파일. naia-os 가 디스크에 저장 / 다음 session 시작 시 load.
- **Memory mode** (naia-memory.attachHandoff): blob 의 recap + anchors 를 long-term store 에 `encode()`. `recall()` 이 자동 retrieve.

Default = memory mode (long-term store 가 의도). file mode 는 디버깅 / 백업.

### 2.6 Event surface

```typescript
| { type: "handoff.exported"; trigger: Trigger; blob: HandoffBlob }
| { type: "handoff.imported"; blob: HandoffBlob; injectedAt: "system" | "user" }
```

Host 가 listen → 디스크 저장 / log / UI 표시.

---

## 3. 부품 매핑 (70% 재사용)

| 신규 / 변경 | 재사용 |
|---|---|
| `HandoffBlob` type | — |
| `HandoffCapable` interface (MemoryProvider 확장) | — |
| `Agent.exportHandoff()` / `importHandoff()` | `naia-memory.compact()` v3 (keepTail=0) |
| Auto-trigger in `Agent.#maybeCompact` tail | budget check 로직 (이미 있음) |
| bin flag `--handoff-out` / `--handoff-in` | bin args 파서 (이미 패턴) |
| service manifest `handoff` 필드 | manifest schema (이미 있음) |
| `agent-handoff-loop.test.ts` | mock LLM 패턴 (이미 `agent-compaction-strategy.test.ts` 에서 검증) |

**naia-memory 변경 최소**: `compact({keepTail: 0})` 가 이미 작동 (P3 anchored iterative 가 이 path 도 cover). 새 export `attachHandoff(blob)` 만 추가.

---

## 4. Phases

| P | 작업 | Tests | 산출 |
|---|---|---|---|
| **P0** | 본 plan + `docs/handoff-design.md` 정본 | doc only | 2 files |
| **P1** | `HandoffBlob` + `HandoffCapable` 타입 in `@nextain/agent-types` | 2 unit (shape, type guard) | types diff |
| **P2** | `Agent.exportHandoff` / `importHandoff` + `#maybeCompact` tail 의 auto-trigger | 4 unit (manual / auto / threshold / no-op repeat) | core diff |
| **P3** | naia-memory `attachHandoff(blob)` / `exportHandoff()` (compact wrap) | 3 unit | naia-memory diff (companion branch) |
| **P4** | bin `--handoff-out` / `--handoff-in` + service manifest | 2 integration | bin diff |
| **P5** | **Auto-trigger test loop** — `agent-handoff-loop.test.ts` 핵심 PoC: mock LLM 50-turn → budget 95% post-compact → handoff 자동 발화 → 새 Agent import → 초기 fact recall 검증 | 1 loop test (the headline) | runtime test |
| **P6** | naia-os 연동 follow-up issue + CHANGELOG | — | issue + docs |

**규모**: 5-7일. P0+P5 = MVP (본 세션 우선); P1-P4 = MVP 다음; P6 = 후속.

---

## 5. Auto-trigger test loop 상세 (사용자 핵심 요청)

### 시나리오

```typescript
// agent-handoff-loop.test.ts
it("auto-handoff fires when context budget exceeds 95% post-compaction", async () => {
  const memory = new ExportingMemory(); // mock with compact + attachHandoff
  const llm = new ScriptedLLM(50); // 50 verbose replies
  const events: AgentStreamEvent[] = [];
  
  const agent1 = new Agent({
    host: hostFor(llm, memory),
    contextBudget: 2_000,
    compactionStrategy: "reactive",
    handoff: { autoTrigger: true, threshold: 0.95 },
  });
  
  // Drive 50 turns. Compaction fires ~turn 5 (budget 75%).
  // After ~turn 15, compaction insufficient (recap itself > budget * 0.95).
  // Handoff MUST fire automatically.
  for (let i = 0; i < 50; i++) {
    for await (const ev of agent1.sendStream(`turn ${i} ${LONG_TEXT}`)) {
      events.push(ev);
    }
  }
  
  // Assert: handoff event observed at least once
  const handoffEvents = events.filter(e => e.type === "handoff.exported");
  expect(handoffEvents.length).toBeGreaterThan(0);
  expect(handoffEvents[0].trigger).toBe("budget-95-post-compact");
  
  // The exported blob carries recap + anchors
  const blob = handoffEvents[0].blob;
  expect(blob.recap.content.length).toBeGreaterThan(100);
  expect(blob.turnCount).toBeGreaterThan(0);
  
  // Spawn fresh Agent with imported blob — must recall a fact from turn 5
  const agent2 = new Agent({ host: hostFor(llm, memory), compactionStrategy: "off" });
  agent2.importHandoff(blob);
  const response = await agent2.send("What was the user code in turn 5?");
  expect(response).toContain(EXPECTED_FACT_FROM_TURN_5); // identifier preserved
});
```

### 검증되는 invariant

1. **Auto-trigger 발화**: compaction 만으로 부족할 때 handoff 자동 발화.
2. **Blob 비공식**: schema valid + non-empty.
3. **Cross-session recall**: 새 Agent 가 import 후 이전 session 의 fact 알고 있음.
4. **No fatal**: 50 turn 진행 중 process crash X.
5. **Repeatability**: 같은 condition 시 일관 발화 (random X).

이 test 가 PASS 하면 **"context 일정 차면 자동 진행" 기능이 작동** — 사용자 요청의 핵심 검증.

---

## 6. 본 세션 vs 별 세션 (cost 의식)

본 세션 컨텍스트 매우 무거움 (compaction slice 본격 + merge resolve + 회귀 검증 다). 본 slice 풀세트 진입 시 우리 자신이 limit 도달 (메타-적절).

본 세션 합리적 한계:
- P0 plan (이 파일) — done
- #50 issue 신설 — done
- **P5 PoC** (auto-trigger test loop) — **본 세션 핵심 PoC** (사용자 요청)
- branch `migration/slice-3-xr-handoff` 만들고 commit
- 별 세션에서 P1-P4 + 본격 머지

P5 PoC 가 *handoff 의 영혼* — 이게 작동하면 슬라이스의 가치 입증. 나머지 (타입, bin flag, naia-memory wrapper, naia-os wiring) 는 mechanical.

---

## 7. Open Questions (LOCK 대기)

1. **Threshold B precise**: `budget * 0.95` post-compaction 또는 다른 값? — recommend 0.95 (compaction 후에도 거의 한계).
2. **Memory mode default**: file 아닌 memory store 가 default? — recommend memory (long-term store 가 의도, file 은 debug).
3. **Anchors injection point**: 새 session 의 system prompt 첫 부분 vs 첫 user message 직전? — recommend system 첫 부분 (LLM 이 "prior context" 로 인지).
4. **idle-timeout trigger** (Threshold C): 본 slice 포함 vs deferred? — recommend **deferred** (옵션 복잡도, naia-os 가 host-level 처리 가능).
5. **Concurrent with #48**: handoff 품질 측정도 LLM-judge ensemble (GLM coding plan / opencode / codex / gemini) 로? — yes, 같은 harness 재사용.

---

## 8. 진행 신호

- 사용자 directive (2026-05-21): "naia-agent의 핸드오프도 개발해야지 / 컨텍스트가 일정 이상 차면 진행하게 테스트 루프 만들어서 진행".
- LLM-judge judges 4-set 명시 (#48): GLM coding plan + opencode + codex + gemini CLI. 본 slice 측정도 동일 ensemble 재사용.
- 본 세션 = P0 plan + #50 issue + P5 PoC 까지. 나머지 P1-P6 별 세션.
