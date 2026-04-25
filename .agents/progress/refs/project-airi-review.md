# ref-project-airi review — 2026-04-25

**Source**: https://github.com/moeru-ai/airi (commit 60456c75, v0.9.0, 553MB monorepo)

## 1. 무엇인가 / 무엇이 아닌가

Project AIRI는 **Neuro-sama 복제 프로젝트**: VRM/Live2D 아바타 + LLM (xsAI 다중 provider 통합) + TTS + STT + 게임 AI 플레이 능력을 갖춘 데스크톱/웹/모바일 버추얼 컴패니언. 

- **구조**: monorepo (pnpm catalog), Apps (stage-web/stage-tamagotchi/stage-pocket) + Packages (60+개) + Bucket (airi.json config) + Integrations (telegram-bot, discord 등)
- **스택**: Vue 3 + Vite (web/desktop), Electron (desktop), Capacitor (mobile), Three.js + Pixiv VRM (avatar), Hono backend (Node.js), Drizzle ORM
- **우리 naia-os와 비교**: 거의 동일한 layer — Tauri shell + 3D avatar + voice. 다만 AIRI는 desktop-first (Electron 현재), 우리는 웹-first (Tauri + Chromium)

## 2. 우리 naia-os와의 비교 — 직접 관련 layer

### Voice Pipeline
AIRI는 **wLipSync 기반 hybrid**:
- **STT** (shell-side, Rust plugin) → audio capture
- **TTS** (agent-side, TS + xsAI) → audio generation + **viseme weights (AEIOUS → AEIOU)**
- **Lip-sync** → wLipSync AudioWorkletNode (Web Audio API) → VRM blendshape 매핑 (aa, ee, ih, oh, ou)

우리는 **Option C (3-layer hybrid)** 선택 (voice-pipeline-audit.md):
- STT 및 TTS 분리
- `VoiceEvent` contract 공유
- viseme 어휘 **미정** (AIRI 참고 가능)

### Avatar/VRM
AIRI: `@pixiv/three-vrm-core` + `@pixiv/three-vrm-animation`
- expressionManager → blendshape setValue (aa, ee, ih, oh, ou, happy, sad, angry, surprised, neutral, think, blink)
- Auto-blink, idle eye movement, look-at
- 감정 상태 → 2단계 blending (primary + runner)

우리: 동일 @pixiv 라이브러리 선택 계획.

### Character / Persona
AIRI: 
- `packages/core-character` — segmentation, emotion, delay orchestration (node pipeline)
- `@proj-airi/ccc` — character card v3 format + book parsing (Character.AI 호환)
- Server-side character 정의 + 클라이언트 캐싱

우리: 미결정 (Phase 1 T5 스코프). AIRI의 CCC v3 포맷이 참고가 될 수 있음.

## 3. 차용 가능한 패턴 후보

### ① wLipSync 통합 패턴
**채택 권고**: wLipSync를 viseme 소스로 명확히 선택.
- AEIOUS → AEIOU 리매핑 (S는 silence/I로 처리)
- Winner + runner 2단계 선택 (모든 5개 vowel 혼합 대신)
- Smooth lerp (ATTACK 50ms, RELEASE 30ms, CAP 0.7)

우리 code: `/var/home/luke/alpha-adk/projects/refs/ref-project-airi/packages/stage-ui-three/src/composables/vrm/lip-sync.ts` 라인 18-127 — 직접 포팅 가능.

### ② VRM Expression 계층화
Primary emotion (0.7–0.8) + secondary emotion (0.15–0.4) blending.
감정 지속 시간 + easing curve 포함. AIRI code: `expression.ts` 라인 40–81 (happy, sad, angry, surprised, neutral, think).

### ③ Plugin/Skill system
AIRI: `@proj-airi/plugin-protocol` (Eventa 기반 WebSocket events) + `@proj-airi/plugin-sdk`
- Module-to-plugin RPC 통합
- 우리는 이미 `@nextain/agent-protocol` 계획했으므로 호환성 검토 가치 있음.

### ④ Core character pipeline
`@proj-airi/core-character` — text segmentation, emotion detection, optional delay + TTS orchestration.
우리 Phase 2 X7 (TTS extraction)과 연계.

## 4. 명시적으로 채택 안 할 이유

**우리는 4-repo 분리 + zero-runtime-dep contract 원칙** (voice-pipeline-audit.md §5, ARCHITECTURE.md §philosophy):
- AIRI는 monorepo (pnpm workspace) → 자유 cross-dependency
- 우리는 repo 경계 엄격: `@nextain/agent-types` zero-runtime-dep, impl packages만 import 가능

AIRI의 모놀리식 구조(backend + 60+ packages + services/)는 우리의 **published interface** 모델과 정반대. Monorepo 의존성 그래프를 우리 방식에 맞게 리구성하는 비용이 이득보다 크다.

## 5. 이미 우리에 반영된 부분

- **Voice pipeline 3-layer hybrid**: 우리가 선택한 Option C, AIRI도 동일
- **Pixiv VRM 선택**: 양쪽 모두 `@pixiv/three-vrm`
- **Eventa 기반 IPC**: 양쪽 모두 타입-안전 이벤트 계약

## 6. R0 채택/거부/이연 권고

- **✓ 채택**: wLipSync AEIOU viseme vocabulary 및 2-stage (winner+runner) 블렌딩 알고리즘. 직접 포팅 가능. (`@nextain/voice-pipeline` Phase 2 X7)
  
- **✓ 채택 검토**: `@proj-airi/core-character` 패턴 (text segmentation + emotion orchestration). 우리 `@nextain/agent-core` emotion layer 설계에 참고.

- **⚠ 이연**: CCC character card v3 형식. 현재 character metadata 스키마 미정. Phase 1 T5에서 검토.

- **✗ 거부**: AIRI monorepo 구조 및 cross-package dependency. 우리 4-repo + zero-runtime-dep 원칙과 상충.

- **✗ 거부**: AIRI backend (Hono + Drizzle + PostgreSQL + Stripe). 우리는 backend-agnostic (`@nextain/agent-types` interface only).

## 7. 열린 질문

1. **viseme ID 정규화**: AIRI는 wLipSync의 AEIOUS를 사용하는데, ARKit, Oculus, 커스텀 VRM 간에 표준이 없다. 우리 `VoiceEvent.viseme` 필드 정의 시 어느 vocabulary를 선택할지? (Phase 1 T5)

2. **Emotion detection**: AIRI의 core-character는 emotion을 "optional" 처리하는데, LLM이 emotion을 직접 emit해야 하나, 아니면 agent-side 휴리스틱으로 감지할 건가?

3. **Character metadata 계약**: CCC v3 포맷(character_book, character_card_v3) vs 우리 간단한 persona 스키마. Phase 1에서 호환성 검토 필요?

---

**결론**: AIRI는 **우리와 같은 architecture layer(voice, avatar, character)를 공유하지만 monorepo 결합도가 높아** 전체 구조 차용은 부적절. 대신 **wLipSync 통합 패턴과 VRM expression blending 알고리즘은 직접 포팅 가치가 높음**. Phase 2 X7 (TTS extraction)과 Phase 1 T5 (character metadata)에서 세부 검토 권고.
