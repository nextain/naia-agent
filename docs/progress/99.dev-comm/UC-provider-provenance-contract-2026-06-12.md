# UC 계약 — Provider 출처(Provider Provenance) — 2026-06-12

> **이 흐름 = new-naia의 첫 canonical 직교 파이프라인(템플릿).** 완성 후 모든 UC가 이 구조를 따른다.
> session_id: 67a0313b-2578-4da2-9a52-53c26128656f

## §A. 목표 / 유저 시나리오
온보딩·설정에서 고른 LLM(provider+model)이 `naia-adk/naia-settings/config.json`에 영속 → agent가 **요청별로 그 provider를 해석** → 대화가 그 provider로 진행(usage **cost 포함**) → UI가 설정된 모델을 표시. 흐름축 = UI → UC → port → transport(stdio→gRPC) → agent → back.

현재 실앱 갭(2026-06-12 발견):
- agent는 `AGENT_PROVIDER` env로 **단일 고정 provider**만 씀(dev 런처가 glm 강제) → config의 gemini 무시. (UI=gemini ↔ 실제=glm 불일치)
- agent가 usage에 **cost 미방출** → 셸 `formatCost(undefined)` 크래시 → ChatPanel 언마운트(대화 사라짐).

## §B. Old-Baseline 골든트레이스 (old-naia-os/agent)
- `providers/registry.ts` — `registerLlmProvider({id,name,envVar,create})` 자가등록.
- `providers/factory.ts`:
  - `buildProvider(config)` → `resolveProviderRoute(config, naiaKey, liveHost)`:
    - `claude-code-cli` → claude-cli
    - naiaKey && liveHost && model=`naia-\d+[gt]-live` → local-live
    - naiaKey && provider∉{ollama,vllm} → **lab-proxy** (api.nextain.io)
    - provider==`nextain` && !naiaKey → error
    - else → **native** (provider별 baseUrl, 키 우선순위 creds_update > config.apiKey > envVar)
  - native baseUrl(family): openai→api.openai.com/v1 · gemini→generativelanguage.googleapis.com/v1beta/openai · xai→api.x.ai/v1 · glm→bigmodel/z.ai · ollama/vllm→host/v1
- `providers/lab-proxy.ts` — **OpenAI-compat `/v1/chat/completions` SSE**, auth = **`X-AnyLLM-Key: naiaKey`**, baseUrl=`labGatewayUrl ?? https://api.nextain.io`.
- `providers/cost.ts` — `calculateCost(model, inTok, outTok) = Σ pricing[model].{input,output}/1e6 * tok` (model 미등록=0). `MODEL_PRICING` 테이블.
- `index.ts:891` — terminal에 `usage{inputTokens,outputTokens,cost,model}` 방출(claude-cli만 cost skip).
- naiaKey = **agent 소유**(auth_update), per-request config에서 안 읽음.

## §C. New 구조 매핑 (이미 있는 것 / 이식할 것)
**이미 있음**: `ports/uc1.ts ProviderPort.chat(config,msgs,opts)` · `CredentialPort{update,get}`(creds_update→{apiKey,naiaKey}) · `ProviderConfig{provider,model,labGatewayUrl,apiKey,naiaKey}` · handler `providerConfig={...req.provider,...creds.get()}` · `makeOpenAICompatProvider({baseUrl,apiKey,model})`(Bearer) · `makeOllamaProvider` · `makeFakeProvider`.
**os side**: `message-router.ts:99 usage→{kind:usage, raw:m}` + `chatChunkToWire usage={...raw}` → **agent가 cost 실으면 ChatPanel까지 통과**(os 코드 변경 불필요).

**이식(agent-side):**
1. `domain/cost.ts` (NEW) — `MODEL_PRICING` + `calculateCost(model,inTok,outTok):number` (순수, old verbatim 이식 + gemini-2.5-flash 등 포함).
2. `domain/chat.ts` (EDIT) — `usage` AgentEmit에 `cost?: number` 추가. `ProviderChunk usage`는 토큰만(provider 레벨), cost는 handler가 terminal 합산 시 계산.
3. `app/chat-turn-handler.ts` (EDIT) — `terminalFinish`에서 `emit({kind:"usage", ...totalUsage, cost: calculateCost(providerConfig.model, in, out)})`. (claude-cli=cost 생략 후속)
4. `adapters/protocol.ts` (EDIT) — wire usage에 `cost`, `model` 포함.
5. `domain/provider-route.ts` (NEW) — 순수 `resolveProviderRoute(config, naiaKey): "lab-proxy"|"ollama"|"native"|"claude-cli"` + `nativeBaseUrl(provider, override)` (old factory 라우팅 이식, local-live/nextain-error는 후속 슬라이스).
6. `ports/uc1.ts` (EDIT) — `ProviderResolverPort{ resolve(config: ProviderConfig): ProviderPort }`.
7. `app/chat-turn-handler.ts` (EDIT) — deps `provider:ProviderPort` → `resolver:ProviderResolverPort`. `runRound`이 `this.d.resolver.resolve(cfg)`로 요청별 해석. (하위호환: `wireAgentUC1({provider})`=상수 resolver 래핑)
8. `adapters/openai-compat-provider.ts` (EDIT) — `auth?: "bearer" | "x-anyllm"`(기본 bearer). x-anyllm → 헤더 `X-AnyLLM-Key: apiKey`. (lab-proxy용, 가법적)
9. `adapters/provider-resolver.ts` (NEW) — `makeProviderResolver(deps)`: route별 인스턴스 — lab-proxy=openai-compat(baseUrl=labGatewayUrl??api.nextain.io, auth=x-anyllm, key=naiaKey) / native=openai-compat(family baseUrl, Bearer, key=apiKey) / ollama=makeOllamaProvider.
10. `scripts/builds/agent-stdio-entry.mjs` (EDIT) — `AGENT_PROVIDER=glm` 강제 **삭제**. resolver 주입(creds/naiaKey 기반 라우팅). AGENT_PROVIDER는 fake/ollama 헤드리스 fallback로만 유지.

**삭제(잘못된 작업 = 고치지 말고 삭제)**: `run-new-core-dev.sh`의 `AGENT_PROVIDER=glm`/`GLM_MODEL` 강제 → config(naia-settings)가 흐르게.

## §D. 수용 기준 (Old-Baseline parity)
- config{provider:gemini, model:gemini-2.5-flash} + 로그인(naiaKey) → 대화가 **gemini(lab-proxy api.nextain.io)** 로 진행.
- usage에 cost 실려 ChatPanel **크래시 없음**, 대화 유지.
- UI 설정 모델 == 실제 사용 provider (불일치 해소).
- env 강제 hack 제거 후에도 동작.
- **검증**: 단위(resolver 라우팅·cost·auth 분기) + tsc + file-anchor 0 FP + e2e-tauri/실앱(Luke).

## §E. 경계
- gRPC transport = 미래(현재 stdio). 안 만듦.
- naia-memory 연결 = 다른 세션. memory_* 미배선.
- local-live(naia-omni), claude-cli, nextain-error 라우팅 = 후속 슬라이스(첫 흐름은 lab-proxy+native+ollama).
