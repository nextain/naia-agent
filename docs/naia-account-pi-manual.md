# Naia 계정으로 Pi 코딩·분석 모델 사용하기

이 문서는 다음 두 경로를 같은 기준으로 설치하고 검증하는 운영 매뉴얼이다.

1. Codex가 `naia-agent` CLI를 호출해 Pi와 Naia 계정 모델을 사용하는 경로
2. 사용자가 `naia-agent` CLI를 단독 실행하는 경로

이번 범위의 모델은 `grok-4.3`과 `deepseek-v4-pro`뿐이다. Grok은 도구를 쓰는 코딩용이고, DeepSeek는 도구를 끈 분석·리뷰용이다. Sol, Terra, Luna와 naia-shell 코딩 작업자는 이번 범위가 아니다.

## 1. 경로와 안전 계약

```text
Codex 또는 사용자
  -> naia-agent run
  -> Pi 0.83.0
  -> provider=naia (강제)
  -> X-AnyLLM-Key: Bearer <Naia 계정 키>
  -> any-llm gateway
  -> Azure model route
```

| 모델 | 용도 | Pi 도구 | 필수 옵션 | Azure 상태 |
|---|---|---:|---|---|
| `grok-4.3` | 파일 편집·명령 실행·검증을 포함한 코딩 | 켬 | 없음 | Preview |
| `deepseek-v4-pro` | 분석·리뷰·설계 검토 | 끔 | `--no-tools` | GA |

보호 규칙은 다음과 같다.

- 두 모델은 Pi에서 `provider=naia`로만 실행된다. `xai`나 `deepseek` 직접 provider 우회는 spawn 전에 실패한다.
- Pi 전용 설정은 `~/.naia-agent/pi/models.json`에 생성되며 실제 키를 저장하지 않고 `$NAIA_API_KEY` 참조만 저장한다.
- Pi 자식 환경은 전역 Pi 디렉터리와 OpenAI/XAI/DeepSeek 직접 키를 상속하지 않는다.
- `deepseek-v4-pro`를 `--no-tools` 없이 실행하면 Pi를 시작하지 않는다.
- gateway도 DeepSeek 요청에 `tools`가 있으면 upstream 호출 전에 HTTP 400으로 거부한다.
- gateway에는 모델별 Azure endpoint/deployment와 `azure:<model>` 가격 행이 모두 있어야 한다. 하나라도 없으면 HTTP 503이다.
- CLI 성공 보고에는 Pi 0.83의 `AssistantMessage`가 보고한 provider/model과 token usage가 포함된다. Pi는 HTTP 응답의 model 필드를 별도로 노출하지 않으므로 이를 “응답 모델 증거”라고 부르지 않는다. 실제 gateway 요청·응답 모델과 `azure:<model>` 청구 키는 gateway 검증에서 별도로 대조한다.

## 2. 설치와 로그인

저장소에서 의존성을 설치하고 빌드한다.

```powershell
cd D:\alpha-adk\projects\naia-agent
pnpm install
pnpm run build
```

Naia 계정 키를 저장한다. 키는 명령줄 기록에 남기지 않도록 `--key`를 생략하고 프롬프트에서 입력하는 방식을 권장한다.

```powershell
node bin\naia-agent.mjs login --provider naia
```

저장 위치는 `~/.naia-agent/.env`의 `NAIA_API_KEY`다. 이미 Shell 런타임이 `NAIA_ANYLLM_API_KEY`를 환경으로 공급하는 경우에도 agent가 같은 계정 키로 정규화해 Pi에 전달한다.

운영 gateway가 기본 `https://api.nextain.io/v1`이 아니면 host 환경에 다음 값을 둔다.

```powershell
$env:NAIA_ANYLLM_BASE_URL = "https://gateway.example.com"
```

## 3. 단독 CLI 실행

### Grok 코딩

```powershell
node bin\naia-agent.mjs run "요구사항을 구현하고 테스트까지 실행해" `
  --agent pi `
  --model grok-4.3 `
  --workdir D:\work\target-project `
  --check "test=pnpm test" `
  --json
```

성공 조건:

- exit code `0`
- `sessionOk: true`
- 검증 명령이 있으면 `verification.ok: true`
- `modelEvidence.provider: "naia"`
- `modelEvidence.selectedModel: "grok-4.3"`
- `modelEvidence.totalTokens > 0`
- 기대한 파일 diff가 존재하고 테스트가 통과

### DeepSeek 분석·리뷰

```powershell
node bin\naia-agent.mjs run "이 변경의 회귀 위험을 분석해" `
  --agent pi `
  --model deepseek-v4-pro `
  --no-tools `
  --workdir D:\work\target-project `
  --json
```

성공 조건은 Grok과 같되 모델 값이 `deepseek-v4-pro`이고 파일 변경은 없어야 한다. `--no-tools`를 빼면 exit code `3`과 `analysis-only` 오류가 나와야 한다.

## 4. Codex에서 호출

Codex에게 대상 디렉터리와 검증 명령을 명시해 위 CLI를 호출하도록 지시한다. 예:

```text
이 작업은 naia-agent CLI의 Pi/Grok으로 수행해.
명령: node D:\alpha-adk\projects\naia-agent\bin\naia-agent.mjs run "<작업>" --agent pi --model grok-4.3 --workdir <대상> --check "test=<검증명령>" --json
JSON의 sessionOk, verification, modelEvidence와 git diff를 확인한 뒤 결과를 보고해.
```

분석만 맡길 때는 모델을 DeepSeek로 바꾸고 반드시 `--no-tools`를 붙인다. Codex가 CLI exit code, JSON 보고서, 실제 diff, 검증 출력을 함께 확인해야 완료다.

## 5. clean-home 격리 검증

새 사용자 환경과 같은 조건을 흉내 내며 직접 provider 키가 Pi에 새지 않는지 확인한다.

```powershell
$saved = @{
  USERPROFILE = $env:USERPROFILE; HOME = $env:HOME
  PI_CODING_AGENT_DIR = $env:PI_CODING_AGENT_DIR
  OPENAI_API_KEY = $env:OPENAI_API_KEY; XAI_API_KEY = $env:XAI_API_KEY
  DEEPSEEK_API_KEY = $env:DEEPSEEK_API_KEY
}
try {
  $testRoot = Join-Path $env:TEMP "naia-pi-clean-home"
  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  $env:USERPROFILE = $testRoot
  $env:HOME = $testRoot
  $env:PI_CODING_AGENT_DIR = Join-Path $testRoot "foreign-pi"
  $env:OPENAI_API_KEY = "must-not-be-used"
  $env:XAI_API_KEY = "must-not-be-used"
  $env:DEEPSEEK_API_KEY = "must-not-be-used"

  pnpm run build
  pnpm exec vitest run src/test/uc-naia-pi-provider.contract.test.ts
  pnpm exec vitest run src/test/uc-naia-pi-controlled.integration.test.ts
  pnpm exec vitest run src/test/uc-naia-pi-cli-process.integration.test.ts
} finally {
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" $saved[$name] }
  }
}
```

첫 테스트는 설정 파일에 실제 키가 없는지, child env가 직접 provider 키를 제거하는지, 누락 키·우회·DeepSeek 도구 사용이 spawn 전에 차단되는지 검사한다. 두 번째 테스트는 실제 Pi 0.83.0을 로컬 Naia 호환 gateway에 연결하여 Grok이 `write` 도구로 파일을 만들고 DeepSeek가 tools 없이 응답하는지 확인한다. 세 번째 테스트는 격리 HOME에서 실제 `login` 프로세스가 저장한 키를 새 CLI 프로세스가 재사용하고, 직접 호출과 한 단계 부모 프로세스 호출의 JSON 증거가 같은지 검증한다.

## 6. naia-shell 연결 검증

이번 범위에서 Shell은 일반 LLM 연결만 검증한다. Coding Workers, Pi lifecycle, Workspace 코딩 UI는 열거나 변경하지 않는다.

1. Naia 계정으로 로그인한다.
2. Settings → Brain에서 provider `Naia`를 선택한다.
3. `Grok 4.3 (Naia)` 또는 `DeepSeek V4 Pro (Naia · Analysis only)`를 선택하고 Apply한다. live gateway metadata가 도착했을 때만 Azure provenance/lifecycle을 확정해 표시한다.
4. Settings를 닫았다 다시 열어 provider/model 선택이 유지되는지 확인한다.
5. 일반 채팅을 1회 실행한다.
6. Grok은 기존 tool 정책을 유지하고, DeepSeek 일반 채팅 요청에는 tools가 전송되지 않는지 확인한다.

자동 검증:

```powershell
cd D:\alpha-adk\projects\naia-shell
pnpm install
pnpm run build
cd packages\shell
pnpm exec vitest run `
  src/lib/llm/__tests__/registry.test.ts `
  src/lib/llm/__tests__/capability-fetch.test.ts `
  src/components/__tests__/SettingsTab.test.tsx
pnpm run build

# Shell의 저장 모델이 Agent request policy로 이어지는 paired contract
cd D:\alpha-adk\projects\naia-agent
pnpm exec vitest run src/test/uc1-openai-compat.contract.test.ts
```

## 7. gateway와 청구 대조

CLI의 `piEstimatedCost`는 Pi 로컬 카탈로그 기준 추정치이며 Naia 청구의 정본이 아니다. 실제 비용·크레딧 검증은 gateway에서 같은 요청의 다음 세 항목을 대조한다.

1. `UsageLog.model_key == azure:grok-4.3` 또는 `azure:deepseek-v4-pro`
2. prompt/completion/total token과 `UsageLog.cost`
3. 같은 usage ID에 연결된 credit 차감 거래와 사용자 잔액 변화

가격 행이 없는 상태, 잘못된 direct-provider prefix, DeepSeek tools 요청은 upstream 호출 수 `0`이어야 한다. 모델별 endpoint 캐시는 Grok→DeepSeek와 DeepSeek→Grok 두 순서 모두 서로 다른 client를 사용해야 한다.

비용 절감률은 한 번의 성공으로 주장하지 않는다. 같은 작업 묶음을 기존 모델과 새 모델로 반복해 token, 경과 시간, 재작업 횟수, 검증 통과율, gateway 실청구를 함께 기록한 뒤 판단한다.

## 8. 실패표

| 증상 | 예상 exit/HTTP | 확인할 것 |
|---|---:|---|
| `NAIA_API_KEY is required` | CLI 3 | `naia-agent login --provider naia` 실행 여부 |
| DeepSeek `analysis-only` | CLI 3 | `--no-tools` 누락 |
| direct provider 거부 | CLI 3 또는 HTTP 400 | 모델 prefix를 제거하고 provider를 `naia`로 사용 |
| `Azure provider/route is not configured` | HTTP 503 | `providers.azure.model_routes.<model>` |
| `Pricing is not configured` | HTTP 503 | canonical `azure:<model>` 가격 행 |
| DeepSeek tool calling 거부 | HTTP 400 | 분석 경로는 tools/tool_choice를 보내지 않음 |
| Pi model mismatch | CLI 3 | CLI 선택 모델과 Pi `AssistantMessage.model` 불일치 |
| `/v1/models`에 모델 없음 | Shell static fallback | gateway 배포 버전과 카탈로그 응답 확인 |
| live 검증 불가 | `OPERATIONAL_UNVERIFIED` | Naia/Azure 자격 증명과 승인된 가격·deployment 준비 여부 |

## 9. 최종 판정 기록

완료 보고에는 다음을 그대로 채운다.

```text
Agent build:
Agent UC/Feature tests:
Agent real-Pi controlled integration:
Shell core build:
Shell production build:
Shell catalog/selection tests:
AnyLLM Azure route tests:
AnyLLM DB/testcontainer tests:
Live Naia/Azure smoke:
Selected/reported model evidence:
Gateway usage/cost/credit evidence:
Known limitations:
```

자격 증명이나 승인된 Azure 배포·가격이 없으면 controlled integration까지는 `PASS`, 실제 Azure 라우팅과 청구는 `OPERATIONAL_UNVERIFIED`로 기록한다. 이를 live 성공으로 바꾸어 쓰지 않는다.

## 참고

- Azure direct 모델과 tool 지원: <https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure>
- Azure 모델 수명 주기: <https://learn.microsoft.com/en-gb/azure/foundry/concepts/model-lifecycle-retirement>
- Azure Grok 4.3 catalog: <https://ai.azure.com/catalog/models/grok-4.3>
- Pi custom model/provider 설정: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md>

## 부록 A. GPT-5.6 캐시 쓰기/읽기 검증

이 부록은 Pi 단독 모델 범위를 넓히지 않는다. Pi 단독 실행은 계속
`grok-4.3`, `deepseek-v4-pro`만 사용한다. Sol/Luna는 naia-agent 일반 채팅
또는 naia-shell이 Naia 계정으로 호출할 때 적용되며, AnyLLM gateway가
사용자 격리와 실제 과금을 소유한다.

### 계약

- Agent는 Naia 경로의 `gpt-5.6-sol`/`gpt-5.6-luna`에만 모델과 정확한
  UTF-8 system prefix로 만든 비밀 없는 client shard를 보낸다.
- Gateway는 shard를 그대로 신뢰하지 않고
  `HMAC-SHA256(jwt_secret, authenticated-user + model + shard)`로 다시 만든다.
- `P=prompt_tokens`, `R=cached_tokens`, `W=cache_write_tokens`, `U=P-R-W`다.
  방어 정규화 후 `U`, `W`, `R`은 겹치지 않으며 합이 `P`다.
- cache write 고객 단가는 Sol `$6.875/M`, Luna `$1.375/M`이다. 이는
  공식 입력 단가 × `1.25` × Naia `1.1`이며 마진은 한 번만 붙는다.
- Azure가 write 필드를 생략하면 Gateway는 토큰을 추정하지 않는다.

### 자동 검증

```powershell
cd D:\alpha-adk\projects\project-any-llm-worktrees\issue-49-azure-naia-models
uv run pytest -q `
  tests\unit\test_cache_write_pricing_init.py `
  tests\unit\test_cache_write_migration.py `
  tests\unit\providers\test_azure_provider.py `
  tests\gateway\test_naia_azure_models.py

cd D:\alpha-adk\projects\naia-agent-worktrees\issue-93-azure-naia-models
pnpm exec vitest run `
  src/test/naia-prompt-cache.contract.test.ts `
  src/test/uc-naia-pi-provider.contract.test.ts
```

### 기존 배포 라이브 검증

새 자원을 만들지 않고 `gpt-5-6-sol`, `gpt-5-6-luna` 기존 배포만 쓴다.
각 모델에 system prefix `stable-naia-prefix `를 1,600회 반복하고 같은
`prompt_cache_key=naia-cache-contract-probe-v1`, 최대 출력 8로 두 번 보낸다.

합격 증거:

1. 첫 응답 모델은 `gpt-5.6-*-2026-07-09`이고 `cache_write_tokens > 0`이다.
2. 두 번째 응답은 같은 snapshot이고 `cached_tokens > 0`이다.
3. 첫 요청의 write와 두 번째 요청의 read는 각각 UsageLog에 보존된다.
4. `ordinary + write + read == prompt_tokens`이고 해당 단가로 계산한 cost와
   같은 usage ID의 credit 차감이 일치한다.
5. 로그·응답·cache key에 사용자 ID, Naia key, Azure key가 나타나지 않는다.

라이브 응답이 write 필드를 주지 않는 Azure 버전에서는 write를 0으로
꾸며 합격시키지 않는다. 이 경우 `write-unreported`로 기록하고 Azure 비용
명세와 대조할 때까지 정확한 write 과금 검증은 `OPERATIONAL_UNVERIFIED`다.

## 10. 운영 검증 기록 — 2026-07-31

이 절은 위 매뉴얼의 최종 판정 양식을 실제 운영 환경에서 수행한 기록이다.

```text
Agent build: PASS
Agent UC/Feature tests: PASS — 126 files, 1,391 tests (9 skipped)
Agent real-Pi controlled integration: PASS
Shell core build: PASS
Shell production build: PASS
Shell catalog/selection tests: PASS — 105 tests
AnyLLM Azure route tests: PASS — 85 focused tests
Live Naia/Azure smoke: PASS
Selected/reported model evidence: PASS
Gateway usage/cost/credit evidence: PASS
Known limitations: claude-opus-5 quota_blocked; Azure가 cache_write_tokens를 보고하지 않는 응답의 write 과금은 미추정
```

실제 명령과 판정:

- DeepSeek: `run --agent pi --model deepseek-v4-pro --no-tools --json`이 exit 0,
  `provider=naia`, `totalTokens=7620`, 요청한 정확 응답을 반환했다.
- Grok: `run --agent pi --model grok-4.3 --check "content=findstr NAIA_GROK_OK naia-smoke.txt" --json`이
  exit 0, `sessionOk=true`, `provider=naia`, `totalTokens=6188`로 끝났고 파일 바이트는
  정확히 `NAIA_GROK_OK\n`이었다.
- Grok 도구 스트림의 종료 청크에 `finish_reason=tool_calls`, prompt/completion/total,
  `cached_tokens=128`, 계산 비용이 함께 포함됐다. 따라서 Pi 모델 증거와 gateway
  스트리밍 과금이 같은 사용량을 본다.
- 운영 UsageLog에는 `provider=azure`, `grok-4.3`과 `deepseek-v4-pro`, 0보다 큰 토큰과
  비용이 저장됐다.
- 별도 DeepSeek 8토큰 호출에서 계정 누적 spend가 `$0.00001914` 증가했다. 이는
  6 input 토큰과 2 output 토큰에 승인된 1.1배 고객 단가를 적용한 값과 일치한다.

배포 정본은 AnyLLM merge commit `6abb91d`, ACR immutable digest
`sha256:ae7c3545ac5b28dd39681ed3aada3d5ad24cda8e0adde9c8b88e70e2e0b501cc`다.
개발·운영 VM 모두 `serve --config /app/config.yml`, `8080:8080`, 포트 8080
헬스체크 계약으로 실행됐으며 운영 공개 `/health`와 모델 카탈로그가 정상이다.
