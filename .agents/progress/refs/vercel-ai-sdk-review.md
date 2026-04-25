# ref-vercel-ai-sdk review — 2026-04-25

**Source**: https://github.com/vercel/ai (commit 10432742, AI SDK 6)
**License**: Apache 2.0 (permissive)
**Stars**: 23,500+

---

## 1. 무엇인가

Vercel AI SDK는 **TypeScript/Node.js 기반 AI 통합 도구집**. `generateText` / `streamText` 분리, `ToolLoopAgent` 클래스(agent-v1)를 중심으로 multi-provider 통일 인터페이스 제공. 50+ AI 공급자 통합(`@ai-sdk/<provider>`), React UI hooks(`useChat`, `useCompletion`) 제공. Apache 2.0 라이선스이므로 상용 도입 가능.

**핵심 모듈**:
- `packages/ai/src/agent/` — ToolLoopAgent, Agent interface
- `packages/ai/src/generate-text/` — streamText, generateText 실제 구현
- `packages/ai/src/tool.ts` (provider-utils 재수출) — tool() 정의 패턴
- `packages/<provider>/` — Anthropic, OpenAI, Google 등 개별 provider 어댑터

---

## 2. 우리 도메인과의 거리

### 같은 점
- **Multi-LLM abstraction**: `LanguageModel` 인터페이스 → provider 플러그인 구조. 우리 `LLMClient` 설계와 동일 철학
- **Stream-first API**: `streamText()` + `generateText()` 래퍼. 우리 D1(Agent.sendStream) 결정과 일치
- **Tool calling**: `tool()` → `inputSchema(zod)` + `execute` 함수 + context 전달. 우리 D5 ToolExecutor 추상화와 근접
- **Callback 체이닝**: `onStepFinish` / `onFinish` / `experimental_onToolExecutionStart/End` — 관찰성 우선. 우리 Logger + Agent event union과 유사
- **Approval flag**: `needsApproval` (deprecated) → `toolApproval` 글로벌 설정. 단순한 human-in-loop 패턴

### 다른 점
- **Next.js/RSC 친화**: React Server Components, streaming response → Node.js ResponseStream. 우리는 backend-agnostic 임베드 런타임
- **모든 provider 직접 의존**: AI SDK는 50개 이상의 `@ai-sdk/<provider>` 패키지 유지. 우리는 Anthropic만 구현(A10), zero-runtime-dep 원칙 위배 회피
- **UI 계층 직결**: `useChat` hook, `UIMessage` 타입, 프론트엔드 상태관리 결합. 우리는 host 책임 분리
- **provider-utils 거대화**: Zod/JSON schema 통합, telemetry 내장, 단일화된 tool 정의 서식. 우리는 단순화된 패턴

---

## 3. 차용 가능한 패턴 후보

1. **ToolLoopAgent class 시그니처** (가능도 ★★★★★)
   - `id` / `tools` / `generate()` / `stream()` 4-member 인터페이스
   - Callback merge 패턴 (settings + call-time override)
   - 우리 Agent가 이미 근접 — 보강 참고 대상

2. **tool() 정의 패턴** (가능도 ★★★★★)
   ```ts
   tool({
     description: string
     inputSchema: Zod | JSON Schema
     execute?(input, options: { toolCallId, messages, context, abortSignal })
     outputSchema?: (선택)
   })
   ```
   - 우리 `ToolDefinition` 스키마에 직접 적용 가능
   - `contextSchema` 추가 — D5 보강에 유용

3. **streamText / generateText 분리** (가능도 ★★★★)
   - 두 함수는 내부적으로 동일 로직 공유(prepareLanguageModelCallOptions, tool normalization)
   - 우리 D1 `send()` vs `sendStream()` 구조와 일치
   - 반복 간결성 — 코드 복제 많음(50개 provider 때문)

4. **onStepFinish / onChunk callback** (가능도 ★★★★)
   - Vercel: `onStepFinish(GenerateTextStepEndEvent)` ← 각 도구 호출 후 호출
   - 우리: `Logger.emit('tool.ended')` + Agent event union
   - 둘 다 비동기, 에러 무시(non-critical) 패턴

5. **needsApproval 단일 flag** (가능도 ★★★)
   - `toolApproval?: ToolApprovalConfiguration<TOOLS, CONTEXT>`
   - 단순화: 글로벌 함수 `approval(toolName) => boolean | Promise<boolean>`
   - 우리 D5와 유사하지만 Vercel은 deprecated → 최신은 AI gateway / provider-level 전환 중

6. **Multi-provider abstraction** (가능도 ★★★★★ / 코드재사용 불가)
   - `@ai-sdk/provider` (interface) ← `@ai-sdk/provider-utils` (shared code) ← `@ai-sdk/<provider>`
   - 50개 provider 모두 이 구조 따름 → 강력한 증거
   - 우리 AnthropicClient는 단일 provider — 하지만 multi-provider 확장 시 Vercel 구조 검토 필수

7. **Prompt cache 자동 처리** (가능도 ★★★)
   - Vercel AI SDK 6: `packages/anthropic/src/` 내 캐시 헤더 자동 생성
   - 우리 C04(prompt cache opinionated 정책) 후보
   - Anthropic provider의 `prepareTools` 내 cache control

---

## 4. 명시적으로 채택 안 할 이유

- **`@ai-sdk/*` 모든 provider 직접 의존** — npm 번들 크기, zero-runtime-dep 위배. 대신 Host가 Anthropic 주입
- **React hooks 결합** — naia-agent는 headless runtime. UI/UX는 naia-os(Host)의 책임
- **Telemetry 내장** — Vercel은 자체 telemetry dispatcher. 우리 Logger/Tracer/Meter 아키텍처로 충분
- **Next.js/Edge runtime 특화** — Tauri shell + self-hosted 모델 → 문제없음. 하지만 참고 우아함

---

## 5. 매트릭스 영향 평가

### §A 보강 후보
- **A01(Stream-first)**: Vercel streamText 구현(내부 tool loop) 검토 — 우리 프로토콜과 일치도 95%
- **A10(AnthropicClient)**: Vercel `@ai-sdk/anthropic` 최신 코드 참고 — prompt cache, vision, thinking 처리

### §C 승격 검토
- **C04(Prompt cache)**: Vercel Anthropic provider의 `cache_control` 헤더 자동화 패턴 — Phase 2에서 정책 수립 시 도입 권고

### §D 신규 후보
- **D05+ 보강** (Tool context): Vercel `ToolExecutionOptions.context` 구조 (`{ toolCallId, messages, abortSignal, context }`) 우리 D5와 병합
- **D09(신규)**: **needsApproval 단순화 패턴** — Vercel 글로벌 approval 함수 대신 우리 `GatedToolExecutor.tierForTool()` 보강

### §E 위험 감소
- **E04(Agent-level smoke)**: Vercel tool-loop-agent.test.ts 구조 참고 — tool approval / step callback 검증

---

## 6. R0 채택/거부/이연 권고

| 항목 | 권고 | 근거 |
|------|------|------|
| **ToolLoopAgent 시그니처 참고** | 채택(A 항목 보강) | 이미 우리 Agent와 유사. 공식 문서화용. |
| **tool() 패턴** | 채택(A 항목 구체화) | inputSchema + execute 는 standard. contextSchema 추가 권고. |
| **streamText / generateText** | 거부 (우리 구현 진행 중) | Vercel은 50개 provider 지원 때문에 복잡. 우리 Anthropic 전용으로 간결화 |
| **Approval 단순화** | 이연 → C -> D09 (Phase 2) | 우리 D5 GatedToolExecutor + Tier 정책이 더 강력. Vercel approve는 deprecated. |
| **prompt cache 자동화** | 이연 → C04 (Phase 2) | C04 트리거 충족 시(policy 정의 후) 도입. |
| **Multi-provider abstraction** | 거부 (지금) | Phase 2 multi-LLM 도입 시 다시 검토. 지금은 Anthropic only. |

---

## 7. 열린 질문

1. **"Vercel needsApproval deprecated인데, 최신 approval 패턴이 뭔가?"**
   → AI Gateway / Anthropic native tool_choice="manual" 으로 전환 중. 우리 D5(GatedToolExecutor tier) 가 더 선진(decoupled).

2. **"prompt cache를 Vercel처럼 자동으로 처리할지, 정책 드러낼지?"**
   → C04 트리거: Phase 2에서 policy decision. Vercel은 cache_control 헤더 자동 생성 — 우리는 명시적 정책이 낫다(Host 이해도 높음).

3. **"tool context의 { toolCallId, messages, context } 구조를 우리 Tool definition에 적용?"**
   → D05 보강: 의의 없음. 채택 권고. 이번 Slice에 추가 가능성 있음.

---

## 참고

- **Architecture**: https://github.com/vercel/ai/blob/main/contributing/provider-architecture.md
- **ToolLoopAgent tests**: `/packages/ai/src/agent/tool-loop-agent.test.ts` (approval, step callback 패턴)
- **Tool definition**: `/packages/provider-utils/src/types/tool.ts` (ToolExecutionOptions, contextSchema)

