# R4 — Hybrid Wrapper Pivot (2026-04-26)

> **session_id**: c03e4e41-9ef4-4809-9ec2-60329e3db5fa
> **status**: in_progress (Week 0 design)
> **prior**: R0 (design recheck) → R1 (slice spine) → R1.5 (harness) → R2 (infra) → R3 (Slices 1~2.7)
> **trigger**: 사용자 본질 고민 — "바닥부터 만드는 게 맞나" + "이게 너무 커지는 것 같아" + "팀장 역할이 피곤"
> **decision**: Hybrid wrapper path (B) — opencode + claude-code SDK를 sub-agent로 wrap, naia-agent는 thin supervisor + 단일 대화 + 정직 보고 + workspace 가시성 layer

---

## 1. R4 motivation (사용자 누적 directive)

R3 종료 시점 (Slice 2.7 완료, 250 PASS) 이후 사용자 자기 반성:

| # | 사용자 직접 인용 |
|---|---|
| 1 | "바닥부터 만드는 게 맞나 하는 고민이 조금 드네" |
| 2 | "코딩 도구로서는 오픈코드가 다양한 프로바이더를 계속 추가하고 성능을 올릴 거고" |
| 3 | "이후 업데이트에 대한 것도 고민이긴 하거든" |
| 4 | "이게 대단히 피곤하단 말이지. 내가 팀장 역할이긴 한데 요즘은 자꾸 놓치니" |
| 5 | "실제 보고와 내용이 달라서 큰 낭패를 보곤 했거든" |
| 6 | "내가 추구하는 건 알파와 대화를 통해 연속적으로 일을 시키는 거야 / 하나의 대화창에서" |
| 7 | "워크스페이스에서 변경을 바로 확인할 수 있고, 어떤 서브세션들이 어떤 일을 하는지도 파악" |
| 8 | "잘못되는 게 보이면 즉시 중지중지를 외치거나 브레이크를 걸고" |
| 9 | "성능과 구조, 유지보수 관점으로 설계, 뼈대 안을 잘 만들기" |
| 10 | "단계별로 크로스 리뷰 받으며 끝까지 진행" |

→ 핵심 vision = **"알파와 단일 대화창 + 정직 보고 + workspace 가시성 + 즉시 interrupt"**

---

## 2. R3까지의 path 한계 (정직 진단)

| 영역 | 자체 build 시 LOC | 1인 6개월 가능? |
|---|:---:|:---:|
| LLM provider 50+ | 1k~5k | △ |
| Coding tool 본체 (bash/file/git/edit/refactor) | 5k~10k | ✗ |
| MCP 통합 | 2k~5k | △ |
| Compaction 정교 | 1k~3k | △ |
| Session SQL persistence | 2k | ✗ (Effect/Drizzle stack 무리) |
| Agent loop core | 1k | ✓ |
| **합계** | **~20k+ (claude-code 50k+ 비교)** | **불가** |

**결론**: claude-code/opencode 수준 자체 build = 1인 1년+ 무리. **Hybrid가 유일한 현실 path**.

---

## 3. Hybrid wrapper 결정 (path B)

### 자체 build 범위 (~1,800~2,200 LOC, 1~2개월)

| 모듈 | LOC | 책임 |
|---|:---:|---|
| `cli/repl.ts` | 200 | 단일 대화창 (REPL) |
| `core/conversation.ts` | 200 | message history + LLM 호출 + 분해/요약 |
| `core/supervisor.ts` | 250 | 다중 sub-agent orchestration + lifecycle |
| `core/interrupt.ts` | 100 | cancel/pause/resume |
| `core/stream-merger.ts` | 150 | N adapter stream → 1 NaiaStream |
| `adapters/opencode/` | 300 | ACP client adapter |
| `adapters/claude-code/` | 200 | Claude Agent SDK adapter |
| `adapters/shell/` | 150 | 단순 child_process (Phase 1용 fallback) |
| `workspace/watcher.ts` | 100 | chokidar |
| `workspace/diff.ts` | 100 | git diff parse |
| `verification/orchestrator.ts` | 150 | 자동 test/lint/build chain |
| `verification/runners/{test,lint,build}.ts` | 150 | 각 runner |
| `report/formatter.ts` | 100 | 수치 기반 정직 보고 |
| `memory/alpha-memory-adapter.ts` | 100 | encode/recall |
| `providers/openai-compat.ts` | 297 (existing) | any-llm 호출 main |
| **합계** | **~2,150** | (existing 297 제외 시 ~1,850 신규) |

### Wrap 범위 (외부 의존, peer dep)

| 외부 | 역할 | naia-agent 의존 |
|---|---|---|
| **opencode CLI** | coding capability sub-agent | ACP JSON-RPC |
| **`@anthropic-ai/claude-agent-sdk`** | Claude Code programmatic | SDK API |
| **`@agentclientprotocol/sdk`** | ACP protocol client | npm peer dep |
| **any-llm gateway** (원격 naia 계정) | LLM provider routing | HTTP OpenAI-compat |
| **vllm-omni** (자체 호스팅) | omni LLM (audio out) | HTTP custom |
| **alpha-memory** (별도 repo) | memory provider | npm peer dep |
| **naia-adk** (향후) | skill 표준 + 카탈로그 | npm peer dep |

### OUT of scope (당분간 안 함)

- 자체 bash/file/git tool 본체 (opencode/cc 위임)
- Vercel AI SDK 50 provider 직접 의존 (any-llm으로 충분)
- 자체 MCP server 운영
- 자체 Compaction 정교 (sub-agent가 처리)
- IDE / file editor / 자체 git impl
- 다중 user / 역할 분리 (1인 사용)

---

## 4. naia-agent 정체성 lock (3차원 차별화)

> **"Real-time interruptible multi-agent supervisor with multi-modal stream + 정직 보고"**

| # | 차별화 영역 | 다른 framework 비교 |
|---|---|---|
| 1 | **Multi-modal stream** (audio_delta 1급) | 다른 framework: text only |
| 2 | **Sub-agent supervisor** (ACP/SDK 기반 통제 + audit + interrupt) | claude-code/opencode: standalone |
| 3 | **단일 대화 + 정직 보고** (workspace diff + 자동 verification + 수치) | 다른 framework: 보고 ≠ 실제 (hallucination 문제) |

### 핵심 책임 (priority)

| 우선 | 책임 |
|:---:|---|
| ★★★ | 단일 대화 인터페이스 |
| ★★★ | Workspace event stream (file watcher + diff) |
| ★★★ | Sub-session event stream (ACP/SDK capture) |
| ★★★ | 자동 verification + 정직 보고 (수치 기반) |
| ★★★ | Real-time interrupt + pause/resume (음성/keypress) |
| ★★★ | Sub-agent supervision (orchestration) |
| ★★ | 연속 context (alpha-memory 통합) |
| ★★ | Multi-modal stream (audio/image forward) |
| ★★ | Interface 정의 (LLMClient/Memory/Skill/SubAgent/Verifier) |

---

## 5. layer 표 (확정)

```
[사용자]
  ↓ voice/text/keypress (interrupt 포함)
naia-shell (별도 repo)
  ├── voice (STT/TTS)
  ├── avatar (VRM)
  └── 통합 UI (대화 main + sub-session 카드 + workspace diff panel)
  ↓ stdio
naia-agent (이 repo, ~2,150 LOC)
  ├── 단일 대화 (conversation)
  ├── workspace watcher + diff
  ├── verification orchestrator
  ├── supervisor (다중 sub-agent)
  └── interrupt manager
  ↓ ACP/SDK/HTTP
[ sub-agents (외부) ]    [ LLM (외부) ]    [ alpha-memory (외부) ]
  ├── opencode (coding)    ├── any-llm gateway   └── encode/recall
  ├── claude-code (coding) ├── vllm-omni (audio)
  └── 다른 ACP-compliant   └── (OpenAI-compat)
```

**의존 방향**: 단방향 (위→아래). naia-agent는 sub-agent/외부 모름 (interface로만).

---

## 6. Week 0 (지금) 작업 — design lock

| step | 산출물 |
|---|---|
| **W0.1** | `docs/architecture-hybrid.md` — 위 layer 정식화 + 모듈 구조 + 의존 방향 |
| **W0.2** | `docs/stream-protocol.md` — NaiaStreamChunk 정식 spec (text/audio/image/tool/workspace/session/verification/report/interrupt/end) |
| **W0.3** | `docs/adapter-contract.md` — SubAgentAdapter spec + opencode/claude-code 매핑 |
| **W0.4** | `docs/vision-statement.md` — vision lock (1쪽) |
| **W0.5** | 매트릭스 §D 갱신 — D18~D24 신규 항목 + §B23 풀 build 거부 |
| **W0.6** | 1차 cross-review (architect + reference-driven + paranoid 3 parallel) |
| **W0.7** | 검토 반영 + docs lock |
| **W0.8** | Phase 1 (Week 1) 5일 spec 정식화 |
| **W0.9** | 2차 cross-review (Phase 1 spec 검토) |
| **W0.10** | 검토 반영 + Phase 1 ready |

R4 종료 = Phase 1 코드 작성 시작점.

---

## 7. 매트릭스 §D 신규 항목 (예정)

| ID | 결정 | 근거 |
|---|---|---|
| **D18** | Hybrid wrapper 채택 (opencode + claude-code SDK를 sub-agent로) | 1인 환경 70k+ LOC 풀 build 불가 |
| **D19** | 단일 대화 + workspace 가시성 + 자동 verification + 수치 보고 | 사용자 vision (보고 ≠ 실제 낭패 해소) |
| **D20** | NaiaStreamChunk multi-modal protocol (audio/image 1급) | omni-voice 시대 (vllm-omni / GPT-4o realtime) |
| **D21** | Real-time interrupt + pause/resume (음성/keypress) | "중지중지" 사용자 통제권 |
| **D22** | vllm-omni adapter (omni audio output, audio_delta passthrough) | 사용자 자체 fork (nextain/vllm-omni MiniCPM-o 4.5) |
| **D23** | Vercel AI SDK 보류 (any-llm으로 충분, 미래 외부 distribution 시 재검토) | any-llm 원격 gateway가 multi-provider routing 자체 제공 |
| **D24** | Sub-agent supervisor pattern (ACP/Claude SDK adapter) | 다중 터미널 워크플로우 자동화 |

§B 신규:

| ID | 거부 | 근거 |
|---|---|---|
| **B23** | naia-agent를 claude-code/opencode 수준 자체 build | 1인 70k+ LOC 1년+ 무리, Hybrid가 현실 |

---

## 8. R4 lock 후 변경 절차

R4 종료 후 본 결정 변경 시:
1. 본 파일에 **Change log** 섹션 추가
2. 매트릭스 §D에 새 항목 + 사유
3. master issue #2에 댓글
4. cross-review 후 진행

§A 항목은 변경 금지 (R0 lock).

---

## 9. Phase별 outline (R4 종료 후 진행)

### Phase 1 (Week 1, 5일) — 가장 작은 검증
- 알파 CLI 대화창 + opencode 1 session 단순 stdio
- chokidar workspace watcher + git diff
- task 후 자동 `pnpm test` + 결과 capture
- 수치 기반 정직 보고
- **검증**: "hello 함수 추가" → 진행 보임 + diff + "test PASS" 보고
- **목표**: 사용자 피로 30~50% 감소 시도

### Phase 2 (Week 2~3) — interrupt + ACP 정식
- ACP client 정식 (tool event capture)
- Interrupt (Ctrl+C → ACP cancel)
- Approval gate (T2/T3 사용자 승인)

### Phase 3 (Week 4~6) — 병렬 + memory
- claude-code SDK adapter
- Sub-session 카드 view (CLI dashboard)
- alpha-memory 어댑터

### Phase 4 (Week 7~10) — 컴패니언화
- Adversarial review
- naia-shell 통합 (voice/avatar)
- vllm-omni adapter (audio_delta)

---

## 10. 진행 트래킹

- **Master issue**: nextain/naia-agent#2 (R4 댓글 추가 예정)
- **R4 progress**: 본 파일
- **TaskList**: #27~#32 (Week 0 단계별)
- **Cross-review**: 단계별 3-perspective parallel
