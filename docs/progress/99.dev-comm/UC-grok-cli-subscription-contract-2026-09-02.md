# UC-GROK — Grok Build CLI 구독 provider 계약

Issue: [nextain/naia-agent#126](https://github.com/nextain/naia-agent/issues/126)
짝: [nextain/naia-shell#529](https://github.com/nextain/naia-shell/issues/529)
Date: 2026-09-02

## 불변

1. `provider=grok` 는 SuperGrok / X Premium+ **로컬 CLI 로그인** 경로다. `provider=xai` 는 `XAI_API_KEY` per-token API 다. 두 경로를 alias 하지 않는다.
2. 어댑터는 `~/.grok/auth.json` 을 읽거나 복사하지 않는다. 인증은 사용자 PC의 `grok` CLI가 소유한다.
3. spawn 환경에서 `XAI_API_KEY` 를 제거한다. 키가 있으면 CLI가 구독 OAuth 대신 종량 API를 탈 수 있다(실측 문서: API key precedence).
4. 채팅 ProviderPort는 사용자 workspace를 쓰지 않는다. cwd = OS tmpdir, 내장 mutating tool 비활성, `--always-approve` 금지, `--max-turns 1`.
5. 구독 호출의 사용자 과금은 $0 (`SUBSCRIPTION_PROVIDERS`에 `grok`). 같은 모델 ID를 `xai`로 부르면 per-token 유지.
6. preflight는 설치/로그인 상태 코드만 반환한다. 계정 식별자·CLI 원문은 노출하지 않는다.

## 와이어

- 헤드리스: `grok -p <prompt> --output-format streaming-messages-json --include-partial-messages`
- 실측(2026-09-02, grok 1.0.13): NDJSON `type=stream_event` 가 Anthropic Messages 이벤트(`text_delta`/`thinking_delta`/`message_delta.usage`)를 감싼다. `apiKeySource=oauth`.
- 기본 모델 `grok-4.6`, 가용 `grok-4.5` (`grok models`).

## 검증

- `src/test/grok-cli-provider.contract.test.ts`
- `src/test/all-providers-wiring.contract.test.ts` grok 분기
- `src/test/uc-provider-provenance.contract.test.ts` 구독 $0
- `src/test/uc-cli-subagent-roster.contract.test.ts` grok roster
- `src/test/uc-cli-subagent-grok.contract.test.ts`
