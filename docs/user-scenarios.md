# User Scenarios (P01) + Test Coverage Map

정본 사용자 시나리오 인덱스. 각 UC 의 권위 계약서는 `docs/progress/UC*-contract*.md` 이며,
이 문서는 그 UC 목록과 테스트 커버리지 맵을 집약한다(SDLC P01 산출물).

## UC 인덱스

| UC | 시나리오 | 권위 계약서 |
|----|----------|-------------|
| UC1 | 에이전트 수평 파이프라인(채팅 턴 = provider 호출 → wire 스트림) | `docs/progress/UC1-agent-horizontal-contract-2026-06-10.md` |
| UC5 | 도구 실행 루프(toolUse → 실행 → 결과 스레딩 → 최종 응답) | `docs/progress/UC5-agent-tool-loop-contract-2026-06-10.md` |
| UC-provider-provenance | provider 라우팅 출처(naia-settings/wire/키체인) | `docs/progress/UC-provider-provenance-contract-2026-06-12.md` |
| UC-memory | 대화 턴 recall 주입 / save(naia-memory 연동) | `docs/progress/UC-memory-recall-save-contract-2026-06-12.md` |
| UC-PROV | provider/model 라이브 교체 — 재기동 없이 다음 턴 반영 | `.agents/progress/new-naia-provider-wiring-2026-06-17.md` |

## UC-MEM-1 (장기기억 회상)

사용자가 한 턴에서 사실을 말하면(예: "내 비밀 코드명은 X야"), 다음 턴에서 그 사실을 물었을 때
("내 코드명이 뭐였지?") 에이전트가 **장기기억에서 회상**해 답한다. 회상된 사실은 모델 사전지식이
아니라 **이전 턴에 저장된 기억**에서 온다. 비활성(memory 미주입) 시 회상되지 않는다(인과 분리).

## UC-PROV-1 (provider/model 라이브 교체)

사용자가 naia-os 설정에서 텍스트 모델/프로바이더를 바꾸면, agent 재기동 없이 **다음 대화
턴부터** 해당 provider 로 응답한다(OS 가 naia-settings 갱신 후 `ReloadSettings`/`SetWorkspace`
재호출 → 활성 `defaultConfig` swap). 모든 naia-os 프로바이더(nextain/gemini/openai/xai/zai/
ollama/vllm)가 연결된다(anthropic/claude-code-cli 는 baseUrl 미정의로 미지원, 후속).

## Test Coverage Map

| 요구 | 테스트 |
|------|--------|
| UC1 | `src/test/uc1-agent.contract.test.ts`, `uc1-*-provider.contract.test.ts` |
| UC5 | `src/test/uc5-*.contract.test.ts`, `uc5-tool-loop-stdio.integration.test.ts` |
| UC-provider-provenance | `src/test/uc-provider-provenance.contract.test.ts`, `uc-keychain-credentials.contract.test.ts` |
| UC-MEM-1 / FR-MEM-1·2·4 | `src/test/uc1-memory-stdio.integration.test.ts` (실 stdio 2턴 recall→inject→provider) |
| FR-MEM-5 격리 / FR-MEM-6 영속·드레인 / FR-MEM-7 bounded / FR-MEM-8 프레이밍 | `uc1-memory-stdio.integration.test.ts`(scope·persist·drain·concurrent·bounded·framing·neutralize) |
| FR-MEM-3 fault-injection(불변식) | `uc1-memory-stdio.integration.test.ts`(recall/save throw·hang → finish 1회·error 없음·usage 1회) |
| 실 프로세스 lifecycle | `src/test/uc1-memory-process.integration.test.ts`(EOF→drain→close→flush, save 영속) |
| UC-PROV-1 / FR-PROV-1·2·3 | `src/test/all-providers-wiring.contract.test.ts`, `uc1-reload-default-config.contract.test.ts`, `uc-naia-settings-store.contract.test.ts` |
| FR-PROV-5 (claude-code SDK 분리) | `src/test/all-providers-wiring.contract.test.ts`(claude-code 케이스 = Agent SDK 라우팅·apiKey 미주입) |
| FR-MODEL-1 (모델 카탈로그 정합) | `src/test/uc-provider-provenance.contract.test.ts`(cost↔registry 정합·구독 $0), naia-os `src/lib/llm/__tests__/registry.test.ts`(카탈로그 정합·최신화) |

> UC1/UC5/provider-provenance 의 상세 시나리오·수용기준은 각 계약서 + `docs/acceptance-criteria.md` 참조.
