# Voice Cascade Contract — naia-agent ↔ LiveKit `llm.LLM`

> **Languages**: English (this file) · [한국어](../.users/docs/ko/voice-cascade-contract.md)
>
> **Parents**: `docs/voice-pipeline-audit.md` (§1 cascade canonical) · `docs/stream-protocol.md` (`audio_delta`) · `docs/adapter-contract.md` (`voice-cascade` adapter row)
>
> **Status**: contract spec (design lock). Implementation deferred to Slice 3-XR-Voice (Task #28, P0c-2) per §4.5 of `slice-3-xr-h-i-j-l-plan-2026-05-20.md`.
>
> **Provenance**: promoted from `naia-labs/promote_to_naia_agent/b5_lite_contract_memo.md` (Codex r3 Q5 conflict + r4 #5 mandatory exit checklist).

---

## 1. Why this contract

LiveKit Agents owns the room session, audio framing, VAD, turn-taking, and the STT ↔ LLM ↔ TTS handoff (`docs/voice-pipeline-audit.md` §1). naia-agent supplies the LLM turn through an adapter that implements LiveKit's `llm.LLM` interface.

Three seams collide at this boundary:

1. naia-agent's **direct path "final-text bias"** — chat surface emits only the sanitized `assistantText` at `turn.ended` (Codex r3 Q1).
2. LiveKit's **streaming chunker** — `LLMStream._event_ch` expects `ChatChunk` deltas to drive TTS chunking and barge-in.
3. naia-memory's **cancelled-turn safety** — voice barge-in cancels mid-turn; cancelled text must not pollute long-term memory.

This document locks four exit gates the P0c-2 implementation MUST satisfy before the slice can merge.

## 2. LiveKit `llm.LLM` reference shape (verified 2026-05-20)

Source: `livekit-agents/livekit/agents/llm/llm.py`.

```python
class LLM(ABC, EventEmitter[Literal["metrics_collected", "error"]]):
    @abstractmethod
    def chat(self, *, chat_ctx, tools, conn_options, ...) -> LLMStream: ...
    async def aclose(self) -> None: ...

class LLMStream(ABC):
    @abstractmethod
    async def _run(self) -> None: ...
    # _event_ch: aio.Chan[ChatChunk]            — plugin pushes partial deltas
    # _task = asyncio.create_task(_main_task)
    # aclose() = asyncio.cancel_and_wait(_task) — cancel propagation primitive

class ChatChunk(BaseModel):
    id: str
    delta: ChoiceDelta | None = None            # partial
    usage: CompletionUsage | None = None
```

Key patterns:
- **Streaming**: plugin pushes `ChatChunk` into `LLMStream._event_ch`.
- **Cancel**: `aclose()` → `asyncio.cancel_and_wait(task)` raises `CancelledError` in every awaited point of `_run()`.
- **Tools**: `chat(tools=[...])` carries them; `Tool` is defined in `tool_context.py`.

## 3. Four exit gates (mandatory before Slice 3-XR-Voice merge)

### G1. Cancel propagates upstream within one turn

A mid-stream barge-in MUST cancel the upstream naia-agent request inside the same turn, not just the LiveKit-side stream.

Wrapper pattern (Python plugin):
```python
class NaiaLLMStream(llm.LLMStream):
    async def _run(self):
        async with self._naia_client.stream(self._chat_ctx) as naia_stream:
            try:
                async for delta in naia_stream:
                    if delta.text:
                        self._event_ch.send_nowait(
                            llm.ChatChunk(id=..., delta=llm.ChoiceDelta(content=delta.text))
                        )
            except asyncio.CancelledError:
                await naia_stream.abort()  # ← upstream propagation
                raise
```

Verification (P0c-2 demo):
- Barge-in trigger via LiveKit `AgentSession` → upstream request observed aborting on the naia-agent side (network trace or SDK debug log).
- Time budget: end-to-end cancellation within one turn boundary.

### G2. No cancelled-turn memory write

A turn cancelled by barge-in MUST NOT result in a naia-memory write.

Wrapper pattern (`VoiceSession`):
```python
class NaiaVoiceSession:
    def __init__(self, ...):
        self._livekit_session = AgentSession(...)
        self._livekit_session.on("conversation_item_added", self._on_item_added)
        # NOTE: cancelled turns must not emit conversation_item_added; if they do,
        # the event MUST carry a flag the handler can branch on.

    def _on_item_added(self, event):
        if event.role == "assistant" and not event.cancelled:
            self._memory.write(event.text, source="voice", ...)
```

Verification (P0c-2):
- Run a barge-in scenario → `memory.recall` returns no partial text from the cancelled turn.
- Memory log shows no cancelled-turn write.

### G3. Partial text is either hidden or marked unstable

LiveKit's TTS chunker needs partial deltas to start speaking before `turn.ended`, but naia-agent's chat surface returns only sanitized final text. The voice path therefore diverges from the chat path.

**Decision (locked)**: voice path streams partials; chat path keeps final-only. The partial path lives behind the `naia-agent[voice]` extra and is isolated from the default chat surface. naia-memory writes ONLY on the final-transcript event (consistent with G2).

Two options were considered:

| Option | Behaviour | Why rejected/accepted |
|---|---|---|
| A (chosen) | Push partial `ChatChunk` as naia-agent emits, mark unstable until final | Lowest deaf_ms; voice-only divergence is contained behind an extra. |
| B | Emit only at sentence boundaries | Adds deaf_ms (sentence-final wait), forfeits the LiveKit chunker's value. |

Verification (P0c-2):
- Measure deaf_ms p50 — target ≤ 500ms on the reference cascade (`ko-serve` + LiveKit + Whisper-large-v3).
- Partial text never appears in `naia-memory` (covered by G2 harness).

### G4. Tool-hop cancel leaves the session reusable

A barge-in during a tool call (e.g. mid-RAG-retrieval) MUST leave the session in a reusable state so the next turn can start cleanly.

Phasing:
- **P0c-1 (standalone, mock LLM)**: no tools — gate is bypassed.
- **P0c-2 (this slice)**: naia-agent tool-hops are wrapped as LiveKit `Tool`s. On mid-tool cancel:
  1. The in-flight tool receives an abort signal (skill protocol).
  2. Host/session state is rolled back to the pre-tool snapshot.
  3. The next turn starts without residual partial state.

Verification (P0c-2):
- Mid-tool barge-in (e.g. RAG retrieval in flight) → next turn proceeds normally.
- Session log carries no orphaned tool partial-state entries.

## 4. LiveKit lock-in re-evaluation triggers (Codex r4)

The current paradigm — "replaceable in principle, dependency in practice" (cf memory `paradigm_agent_layer_is_our_value`) — keeps LiveKit as the orchestration commodity. A re-evaluation against Pipecat (or another backbone) is triggered ONLY if at least one of the following fails during P0c-1 or P0c-2:

1. G1 cancel propagation cannot reach one-turn (e.g. the upstream client SDK does not cancel the in-flight stream).
2. G2 cancelled-turn writes are unavoidable (memory pollution observed).
3. G3 partial-text leakage contaminates a policy decision surface (e.g. the TTS chunker).

G4 alone is not a trigger — it is a wrapper-design decision rather than a backbone limitation.

## 5. Verification placement

The four gates map onto the existing adapter-contract test ladder (`docs/adapter-contract.md` §2 Contract tests). They will be filed as `voice-cascade`-adapter-specific entries when the Slice 3-XR-Voice scaffold introduces the `voice-cascade` adapter package. Until then they live in this document as the design lock.

## 5A. P0c-2 real-mode verification status (2026-05-21, updated from naia-labs Phase F.5/F.6)

All four exit gates verified real-mode (RTX 3090 GPU0, ollama gemma3n:e4b, VoxCPM2 + Whisper services). Harness lives under `nextain/naia-labs/.agents/voice_cascade/p0/p0c2/harness/`.

| gate | mock | **real** | target | status |
|---|---:|---:|---|:---:|
| G1 cancel propagates upstream | 20 ms | **164 ms** (mock × 8.2) | ≤ 300 ms | ★ pass |
| G2 no cancelled-turn write | 0 leaks | **0 leaks** (10 scenarios) | 0 | ★ pass |
| G3 chain deaf_ms p50 | 50 ms | **332 ms** (Whisper small int8 beam=1) | ≤ 500 ms | ★ pass |
| G4 tool-hop cancel reusable | 0 orphan | **0 orphan** (10 scenarios) | 0 | ★ pass |

**Mock vs real gap (paradigm lesson)**:
- G1 8.2×, G3 6.6× — mock measurement is contract-logic validation only, not a latency proxy. Real-mode measurement is mandatory before merge.
- mock-and-real both required = "adversarial code-read review + live-call smoke" paradigm (3-round adversarial chain at `naia-labs/.../reviews/adversarial_summary_f{,_f3,_f4}.md`).

**Phase F.5/F.6 산출** (production spec promote: `nextain/naia-labs/promote_to_naia_agent/voice_session_spec.md`):
- `nextain/naia-model-infra/python/voice_session/` `VoiceSession.start()` 실 구현 (LiveKit AgentSession + plugins + memory hook)
- `nextain/naia-model-infra/python/livekit-plugins-naia-{voxcpm2,whisper-faster,llm}/` editable install + wire smoke PASS
- `nextain/naia-labs/.../harness/voice_session_wire_smoke.py` LiveKit dev server room connect 401.7 ms + VoiceSession.start() 16.7 ms PASS

## 5B. Slice 3-XR-Voice entry prerequisites (단계 4)

Order for entry:

1. **`bin/naia-agent.ts --serve-openai-compat <port>`** — host sidecar
   - `/v1/chat/completions` SSE (LiveKit Python LLM plugin client)
   - `/v1/memory/{recall,write}` (LiveKit voice_session memory hook → naia-memory `LiteMemoryProvider` direct wire)
   - HTTP request abort → upstream Agent-SDK stream cancel (G1)
2. **STT VAD wrap** — silero VAD plugin (current F.6-1 wire warning: "STT does not support streaming, add VAD")
3. **`allow_interruptions` → `turn_handling=TurnHandlingOptions(...)`** — livekit-agents 1.5.11 API migration
4. **Full audio I/O smoke** — LiveKit local audio publish + STT recognize + LLM response + TTS first-chunk arrival 실측 (current F.6-1 wire smoke is idle-only)

## 6. References

- `docs/voice-pipeline-audit.md` §1 — cascade canonical.
- `docs/stream-protocol.md` — `audio_delta` chunk shape.
- `docs/adapter-contract.md` — `voice-cascade` adapter row (deferred placeholder).
- `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md` §4.5 — P0c-1 / P0c-2 split.
- Memory:
  - `project_naia_voice_cascade_2026_05_20` — track SoT.
  - `project_voice_p0c_split_2026_05_20` — P0c split decision.
  - `paradigm_agent_layer_is_our_value` — "replaceable in principle".
  - `project_minicpm_o_4_5_deprecated_2026_05_20` — prior plan deprecation.
- Provenance: `naia-labs/promote_to_naia_agent/b5_lite_contract_memo.md` (Codex r3 Q5 + r4 #5).
