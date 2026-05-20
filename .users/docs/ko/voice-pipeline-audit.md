# 음성 파이프라인 감사 (Voice Pipeline Audit)

> **언어**: [English](../../../docs/voice-pipeline-audit.md) · 한국어 (이 파일)

> ## ⚠️ DEPRECATED — MiniCPM-o-4.5 / vllm-omni / Option C 계획
>
> 이전에 본 문서에 기록되어 있던 MiniCPM-o-4.5 + vllm-omni + Option C
> (3-layer hybrid) 계획 전체는 **2026-05-20부로 폐기**되었다.
>
> 폐기 근거 = 메모리 엔트리 `project_minicpm_o_4_5_deprecated_2026_05_20`.
> 정본 대체 = §1 의 LiveKit Agents + VoxCPM2 + Whisper-large-v3 cascade.
>
> MiniCPM-o-4.5 서술은 추적 가능성을 위해 §3 (히스토리 아카이브) 에만
> 남겨 둔다. **해당 계획에 맞춰 작업하지 말 것**.

본 문서는 `naia-agent` 의 정본 음성 파이프라인 감사다. 현재 cascade 아키텍처,
naia-agent 통합 경계 (Task #28, P0c-2), 그리고 폐기된 Option C 계획의
히스토리를 기록한다.

## 1. 현재 음성 cascade (정본, 2026-05-20)

새 음성 경로는 LiveKit Agents 프레임웍이 오케스트레이션하는 3-stage
오픈 cascade다:

| 단계 | 컴포넌트 | 비고 |
|---|---|---|
| STT | Whisper-large-v3 | 음성 → 텍스트. cascade 모드 사용 기준으로 레거시 Tauri Rust STT 플러그인 경로를 대체. |
| LLM | naia-agent 런타임 | 텍스트 → 텍스트. CLI / host API 와 동일한 런타임, 변경 없이 재사용. |
| TTS | VoxCPM2 (OpenAI-compatible 엔드포인트) | 텍스트 → 오디오. 벤더 중립을 위해 OpenAI-compatible TTS HTTP surface 로 노출. |

LiveKit Agents 가 실시간 룸 세션, 오디오 framing, VAD, turn-taking,
STT ↔ LLM ↔ TTS handoff 를 모두 소유한다. naia-agent 는 비-음성 표면과
완전히 동일한 LLM 턴을 제공한다.

### Task 추적

- **Task #28 (Slice 3-XR-Voice)** — `P0c-2`: naia-agent integration 만.
  상태: **deferred** (Slice 3-XR-M/N/O 종료 후 또는 별 세션에서 진입).
- **P0c-1** — standalone tech demo (LiveKit ↔ ko-serve, mock LLM,
  naia-agent 의존 0). 상태: **다른 세션에서 산출됨**. 본 레포에 없는
  reference 자산.

`P0c` 를 vendor-side standalone demo (P0c-1) 와 naia-agent-side
integration slice (P0c-2) 로 분리하면, product viability 리스크
(cascade 자체) 와 naia-agent 통합 리스크 (LLM wrapper + memory hook
seam) 가 격리된다.

### naia-agent 통합 표면 (Task #28, P0c-2 범위)

통합은 의도적으로 작다:

1. **`livekit-plugins-naia-voxcpm2`** — VoxCPM2 OpenAI-compatible 엔드포인트를
   LiveKit Agents 에 TTS provider 로 노출하는 플러그인.
2. **naia LLM → LiveKit wrapper** — naia-agent 한 턴 (text-in / text-out)
   을 LiveKit Agents LLM 인터페이스에 맞춤.
3. **`VoiceSession`** — 단일 룸 참가자 cascade 를 호스팅하는 오케스트레이션 객체.
4. **Memory hook** — naia-agent `--memory` recall 경로를 연결해 음성 턴도
   CLI 턴처럼 장기 recall 에 참여하도록 wire. `docs/memory-provider-audit.md`
   참고.

cross-review 에서 부각된 direct-path "final-text bias" 리스크는 P0c-2
안에서 해결된다. P0c-1 은 mock LLM 으로 우회한다. 해당 해결의 exit-gate
스펙 (G1 cancel 전파, G2 cancel 시 write 안 함, G3 partial 텍스트 경로,
G4 tool-hop cancel) 은 `docs/voice-cascade-contract.md` 에 잠금되어 있다.

## 2. 출처 레퍼런스

- `docs/voice-cascade-contract.md` — Slice 3-XR-Voice 머지 전 P0c-2 구현이
  반드시 충족해야 하는 4개 exit gate (G1–G4) + LiveKit lock-in 재평가
  트리거.
- `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md` §4.5 — 음성 트랙
  분리 (P0c-1 standalone vs P0c-2 naia-agent integration), §5 deferred
  ledger `3-XR-Voice (#28) = P0c-2 only`.
- `CHANGELOG.md` Slice 3-XR-M/N/O 엔트리 — "Voice 트랙 (#28) 분리 흡수"
  섹션 (Task #28 description 이 P0c-2 만으로 좁혀짐).
- 메모리 엔트리 `project_minicpm_o_4_5_deprecated_2026_05_20` — 이전
  MiniCPM-o-4.5 / vllm-omni / Option C 계획의 폐기 근거.

## 3. 히스토리 아카이브 — Option C (DEPRECATED)

아래는 MiniCPM-o-4.5 + vllm-omni 기반의 이전 Option C (3-layer hybrid)
계획이다. 추적용으로만 보존하며 **이 계획에 맞춰 작업해서는 안 된다**.
정본 계획은 §1 이다.

### 3.1 원래 TTS 레이어 (3) — historical

| 레이어 | 위치 | 역할 |
|---|---|---|
| Provider SDK | `naia-os/agent/src/tts/*.ts` (8 파일 — edge, elevenlabs, google, nextain, openai + registry + types + gcp-auth) | TTS provider 직접 호출 |
| Skill entry | `naia-os/agent/src/skills/built-in/tts.ts` | provider 호출에 wire 된 skill descriptor |
| Gateway proxy | `naia-os/agent/src/gateway/tts-proxy.ts` | OpenClaw-era 의 shell ↔ TTS 브리지 |

### 3.2 원래 STT 레이어 — historical

| 레이어 | 위치 | 역할 |
|---|---|---|
| Native STT 모델 | `naia-os/shell/src-tauri/src/stt_models.rs` | Rust-side STT 통합 |
| Tauri 플러그인 | `naia-os/shell/src-tauri/plugins/tauri-plugin-stt/` | shell 용 STT provider 플러그인 |
| E2E 테스트 | `naia-os/shell/e2e-tauri/specs/{77,86,88,99}-stt-*.spec.ts` | shell 을 통한 풀-파이프라인 테스트 |
| GCP auth (TTS 와 공유) | `naia-os/agent/src/tts/gcp-auth.ts` | shell STT 와 agent TTS 가 함께 쓰는 Google Cloud auth |

### 3.3 원래 비대칭 사유 — historical

- TTS = agent-side (TS, `agent/src/tts/` 하위 8 파일).
- STT = shell-side (Rust, native plugin).
- 공유 인프라: Google Cloud auth — 물리적으로는 `agent/src/tts/` 에 있지만
  두 레이어가 같이 사용.

비대칭은 역사적 산물이었다:

- TTS = 텍스트 → 오디오. SDK 로 Node.js 구현이 쉬움.
- STT = 오디오 → 텍스트. OS 오디오 캡처 = low-level 이라 Rust 플러그인이 자연스러움.
- VRM 아바타 lip-sync (shell `@pixiv/three-vrm`) 이 TTS 가 emit 하는
  **viseme** 이벤트를 소비 → TTS 가 agent 에 있어도 shell 결합이 tight.

### 3.4 원래 Option C — historical, DEPRECATED

2026-04-21 에 기록된 Option C (3-layer hybrid) 결정 ("Phase 0 S6
closed") 은 §1 의 LiveKit Agents cascade 로 **대체되었다**. Option C
에 맞춰 구현하지 말 것. `@nextain/agent-types` 의 `VoiceEvent` 컨트랙트,
`@naia-agent/tts` 추출 (구 Phase 2 X7), agent-side/shell-side 소유권
분할은 모두 폐기됐다.

## 4. 레퍼런스 (current)

- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md`
  — 음성 섹션은 cascade 반영 갱신 필요 (별 task).
- Slice plan: `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md`
  §4.5 (음성 트랙 분리) + §5 (deferred ledger).
- CHANGELOG: Slice 3-XR-M/N/O 엔트리 "Voice 트랙 (#28) 분리 흡수".
- 메모리: `project_minicpm_o_4_5_deprecated_2026_05_20`.
