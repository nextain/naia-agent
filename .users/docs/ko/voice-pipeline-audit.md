# Voice Pipeline Audit

> **언어**: [English](../../../docs/voice-pipeline-audit.md) · 한국어 (이 파일)

## 경계

Voice 파이프라인 (STT, TTS, 오디오 장치 I/O, 스트리밍 오케스트레이션)은 **naia-os + naia-omni 영역**입니다.

naia-agent의 Voice에서의 역할: **LLM brain만** — 텍스트 입력, 텍스트 출력. CLI와 동일한 런타임.

naia-agent는 naia-omni 내부 구현 기술(STT·TTS·오디오 하드웨어 포함)에 의존하지 않습니다.

## 통합 패턴

```
naia-omni / naia-os
  ├── 오디오 장치 I/O (마이크/스피커)
  ├── STT → 텍스트
  └── 텍스트 → naia-agent (chat_request IPC)
              ↓ LLM 응답 텍스트
  ├── TTS → 오디오
  └── 오디오 재생
```

naia-agent는 텍스트 `chat_request`만 봅니다. 주변 음성 세션을 인식하지 않습니다.

## 역사적 노트 (DEPRECATED 계획)

- **Option C (MiniCPM-o-4.5 / vllm-omni / 3-layer hybrid)** — 2026-05-20 deprecated. 메모리 `project_minicpm_o_4_5_deprecated_2026_05_20` 참조.
- **P0c-2 / Slice 3-XR-Voice "naia-agent integration"** — 철회. naia-agent는 Voice 오케스트레이션을 직접 담당하지 않음. naia-os/naia-omni 영역.
