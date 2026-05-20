# 음성 cascade 컨트랙트 — naia-agent ↔ LiveKit `llm.LLM`

> **언어**: [English](../../../docs/voice-cascade-contract.md) · 한국어 (이 파일)
>
> **상위 문서**: `docs/voice-pipeline-audit.md` (§1 정본 cascade) · `docs/stream-protocol.md` (`audio_delta`) · `docs/adapter-contract.md` (`voice-cascade` adapter 행)
>
> **상태**: 컨트랙트 spec (design lock). 구현은 Slice 3-XR-Voice (Task #28, P0c-2) 진입 시점까지 보류. `slice-3-xr-h-i-j-l-plan-2026-05-20.md` §4.5 참조.
>
> **출처(promote)**: `naia-labs/promote_to_naia_agent/b5_lite_contract_memo.md` (Codex r3 Q5 자명한 충돌 + r4 #5 mandatory exit checklist).

---

## 1. 본 컨트랙트가 필요한 이유

LiveKit Agents 가 룸 세션, 오디오 framing, VAD, turn-taking, STT ↔ LLM ↔ TTS 핸드오프를 소유한다 (`docs/voice-pipeline-audit.md` §1). naia-agent 는 LiveKit `llm.LLM` 인터페이스를 구현하는 어댑터를 통해 LLM 턴을 공급한다.

이 경계에서 세 가지 seam 이 부딪힌다:

1. naia-agent 의 **direct path "final-text bias"** — chat surface 는 `turn.ended` 의 sanitized `assistantText` 만 emit (Codex r3 Q1).
2. LiveKit 의 **스트리밍 chunker** — TTS chunking + barge-in 을 구동하려면 `LLMStream._event_ch` 가 `ChatChunk` delta 를 받아야 함.
3. naia-memory 의 **cancel turn 안전성** — voice barge-in 이 턴 중간을 cancel; cancel 된 텍스트가 장기 기억을 오염시키면 안 됨.

본 문서는 P0c-2 구현이 슬라이스 머지 전에 반드시 충족해야 하는 4개 exit gate 를 잠근다.

## 2. LiveKit `llm.LLM` 레퍼런스 형태 (2026-05-20 검증)

출처: `livekit-agents/livekit/agents/llm/llm.py`.

```python
class LLM(ABC, EventEmitter[Literal["metrics_collected", "error"]]):
    @abstractmethod
    def chat(self, *, chat_ctx, tools, conn_options, ...) -> LLMStream: ...
    async def aclose(self) -> None: ...

class LLMStream(ABC):
    @abstractmethod
    async def _run(self) -> None: ...
    # _event_ch: aio.Chan[ChatChunk]            — plugin 이 partial delta 를 push
    # _task = asyncio.create_task(_main_task)
    # aclose() = asyncio.cancel_and_wait(_task) — cancel 전파 primitive

class ChatChunk(BaseModel):
    id: str
    delta: ChoiceDelta | None = None            # partial
    usage: CompletionUsage | None = None
```

핵심 패턴:
- **Streaming**: plugin 이 `ChatChunk` 를 `LLMStream._event_ch` 에 push.
- **Cancel**: `aclose()` → `asyncio.cancel_and_wait(task)` 가 `_run()` 안의 모든 await 점에 `CancelledError` 를 던진다.
- **Tools**: `chat(tools=[...])` 로 전달, `Tool` 정의는 `tool_context.py`.

## 3. 4개 exit gate (Slice 3-XR-Voice 머지 전 의무)

### G1. cancel 이 한 턴 안에 upstream 까지 전파

턴 중간 barge-in 은 LiveKit 측 스트림만이 아니라 동일 턴 안에서 upstream naia-agent 요청까지 cancel 시켜야 한다.

Wrapper 패턴 (Python plugin):
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
                await naia_stream.abort()  # ← upstream 전파
                raise
```

검증 (P0c-2 데모):
- LiveKit `AgentSession` 의 barge-in trigger → naia-agent 측에서 upstream 요청이 실제 abort 됨 (네트워크 trace 또는 SDK debug log).
- 시간 예산: 한 턴 경계 안에서 end-to-end cancel.

### G2. cancel 된 턴은 memory write 안 함

barge-in 으로 cancel 된 턴은 naia-memory 에 절대 write 되면 안 된다.

Wrapper 패턴 (`VoiceSession`):
```python
class NaiaVoiceSession:
    def __init__(self, ...):
        self._livekit_session = AgentSession(...)
        self._livekit_session.on("conversation_item_added", self._on_item_added)
        # NOTE: cancel 된 턴은 conversation_item_added 를 emit 하면 안 됨;
        # emit 한다면 handler 가 분기할 수 있는 flag 를 carry 해야 함.

    def _on_item_added(self, event):
        if event.role == "assistant" and not event.cancelled:
            self._memory.write(event.text, source="voice", ...)
```

검증 (P0c-2):
- barge-in 시나리오 실행 → `memory.recall` 이 cancel 된 턴의 partial 텍스트를 반환하지 않음.
- memory log 에 cancel 턴 write 없음.

### G3. partial 텍스트는 hide 또는 unstable mark

LiveKit 의 TTS chunker 는 `turn.ended` 전에 말하기 시작하려면 partial delta 가 필요하지만, naia-agent 의 chat surface 는 sanitized final 텍스트만 반환한다. voice path 는 chat path 와 분기한다.

**결정 (잠금)**: voice path 는 partial 을 streaming; chat path 는 final-only 유지. partial path 는 `naia-agent[voice]` extra 뒤에 두고 default chat surface 와 격리. naia-memory write 는 final-transcript 이벤트에서만 (G2 와 일관).

검토된 두 옵션:

| 옵션 | 동작 | 채택/기각 사유 |
|---|---|---|
| A (채택) | naia-agent emit 즉시 partial `ChatChunk` push, final 전까지 unstable mark | deaf_ms 최저; voice-only 분기는 extra 뒤로 격리됨. |
| B | 절 경계에서만 emit | deaf_ms 증가(절 종결 대기), LiveKit chunker 가치 상실. |

검증 (P0c-2):
- deaf_ms p50 측정 — 레퍼런스 cascade (`ko-serve` + LiveKit + Whisper-large-v3) 에서 ≤ 500ms.
- partial 텍스트가 `naia-memory` 에 등장 안 함 (G2 harness 와 합산).

### G4. tool-hop cancel 후 세션 재사용 가능

tool 호출 중간 (예: RAG retrieval mid-call) barge-in 발생 시 세션은 다음 턴을 깔끔히 시작할 수 있는 재사용 상태로 남아야 한다.

단계화:
- **P0c-1 (standalone, mock LLM)**: tool 없음 — 본 gate 우회.
- **P0c-2 (본 슬라이스)**: naia-agent tool-hop 을 LiveKit `Tool` 로 wrap. 중간 cancel 시:
  1. in-flight tool 이 abort signal 받음 (skill 프로토콜).
  2. host/session state 가 tool 실행 전 snapshot 으로 롤백.
  3. 다음 턴이 잔류 partial state 없이 시작.

검증 (P0c-2):
- tool 중간 barge-in (예: RAG retrieval 진행 중) → 다음 턴 정상 진행.
- 세션 로그에 orphan tool partial-state 항목 없음.

## 4. LiveKit lock-in 재평가 trigger (Codex r4)

현재 패러다임 — "원리는 교체 가능, 실무는 dependency" (메모리 `paradigm_agent_layer_is_our_value` 참조) — 는 LiveKit 을 오케스트레이션 commodity 로 유지한다. Pipecat (또는 다른 backbone) 재평가는 P0c-1 또는 P0c-2 에서 다음 중 하나라도 FAIL 시에만 트리거된다:

1. G1 cancel 전파가 한 턴 안에 도달 못 함 (예: upstream client SDK 가 in-flight stream 을 cancel 안 함).
2. G2 cancel 턴 write 가 회피 불가 (memory 오염 관찰됨).
3. G3 partial 텍스트 누출이 정책 결정 surface 를 오염 (예: TTS chunker).

G4 단독은 trigger 아님 — wrapper 설계 결정이지 backbone 한계 아님.

## 5. 검증 배치

4개 gate 는 기존 adapter-contract test 사다리 (`docs/adapter-contract.md` §2 Contract tests) 에 매핑된다. Slice 3-XR-Voice scaffold 가 `voice-cascade` 어댑터 패키지를 도입하는 시점에 `voice-cascade`-어댑터 전용 항목으로 등재 예정. 그때까지는 본 문서가 design lock 으로 유지.

## 6. 참조

- `docs/voice-pipeline-audit.md` §1 — cascade 정본.
- `docs/stream-protocol.md` — `audio_delta` chunk 형태.
- `docs/adapter-contract.md` — `voice-cascade` 어댑터 행 (deferred placeholder).
- `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md` §4.5 — P0c-1 / P0c-2 분리.
- 메모리:
  - `project_naia_voice_cascade_2026_05_20` — 트랙 SoT.
  - `project_voice_p0c_split_2026_05_20` — P0c 분리 결정.
  - `paradigm_agent_layer_is_our_value` — "replaceable in principle".
  - `project_minicpm_o_4_5_deprecated_2026_05_20` — 이전 계획 폐기.
- 출처: `naia-labs/promote_to_naia_agent/b5_lite_contract_memo.md` (Codex r3 Q5 + r4 #5).
