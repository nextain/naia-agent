# naia-agent CLI manual

이 문서는 `naia-agent`를 Naia 계정 기반 독립 코딩 CLI로 설정하고 검증하는 실행 매뉴얼이다.
현재 Pi 모델은 `grok-4.3`(도구 코딩)과 `deepseek-v4-flash`/`deepseek-v4-pro`(도구 없는 분석)다.
naia-shell의 코딩 Workspace UI는 이 범위가 아니다.

## 1. 설치 확인

```powershell
Get-Command naia-agent
naia-agent --version
naia-agent --help
```

저장소 빌드를 직접 검증할 때는 아래처럼 실행한다.

```powershell
cd D:\alpha-adk\projects\naia-agent
pnpm install --frozen-lockfile
pnpm build
node bin\naia-agent.mjs --help
```

## 2. 저장 위치와 권위

| 데이터 | 위치 | 의미 |
|---|---|---|
| workspace 포인터 | `~/.naia-agent/config.json` | 이 PC가 사용할 Naia workspace |
| 코딩 기본값 | `<workspace>/naia-settings/cli.json` | agent/model/tools; workspace 설정 정본 |
| Windows 계정 키 | `<workspace>/naia-settings/.keys/<NAME>.dpapi` | Windows CurrentUser DPAPI 암호문 |
| Linux 계정 키 | secret-tool `service=naia-agent, account=<NAME>` | OS keyring |
| 대화 세션 | `<workspace>/conversations/<session-id>.jsonl` | 기존 Agent transcript; 새 DB 없음 |

새 로그인은 평문 `.env`에 쓰지 않는다. 기존 `~/.naia-agent/.env`는 읽기·마이그레이션
호환만 제공하며, 같은 provider로 로그인하면 해당 legacy 줄을 제거한다.

## 3. Naia 계정

상태 확인:

```powershell
naia-agent auth status
naia-agent auth status --provider naia --json
```

로그인:

```powershell
naia-agent auth login --provider naia
```

TTY에서는 키가 화면에 표시되지 않는다. 자동화에서만 `--key` 또는 stdin을 쓸 수 있다.
`--key`는 프로세스 목록과 셸 히스토리에 노출될 수 있으므로 사람이 직접 로그인할 때는 쓰지 않는다.

로그아웃:

```powershell
naia-agent auth logout --provider naia
```

`status`는 로그인 여부와 `dpapi`, `secret-tool`, `environment`, `legacy-env` 같은 출처만
출력한다. 키 값은 출력하지 않는다.

## 4. workspace와 코딩 기본값

```powershell
naia-agent config set workspace D:\alpha-adk
naia-agent config set coding.agent pi
naia-agent config set coding.model grok-4.3
naia-agent config set coding.tools true
naia-agent config list
naia-agent config list --json
```

DeepSeek 분석을 기본으로 쓸 때:

```powershell
naia-agent config set coding.model deepseek-v4-pro
naia-agent config set coding.tools false
```

명령줄의 `--agent`, `--model`, `--tools`, `--no-tools`가 저장 기본값보다 우선한다.
다른 agent를 명시하면 저장된 Pi 모델은 따라붙지 않는다. 예를 들어
`--agent codex`에 Pi용 `grok-4.3`이 자동 전달되지 않는다.

설정 초기화:

```powershell
naia-agent config reset coding.model
naia-agent config reset
```

## 5. 모델과 진단

```powershell
naia-agent models
naia-agent models naia --json
naia-agent doctor
naia-agent doctor --json
```

`models`의 `source`:

- `live`: Naia gateway의 현재 모델 응답
- `fallback`: gateway를 확인하지 못해 내장 Pi 목록만 표시; 경고를 함께 출력

`doctor`는 `account.naia`, `workspace`, `naia-settings`, `pi`, `models`를 각각
`pass`, `warn`, `fail`로 판정한다. `ready=false` 또는 exit code 1이면 코딩 전 실패 항목을 고친다.

## 6. 코딩과 분석

Grok 코딩:

```powershell
naia-agent run "요청한 파일을 수정하고 테스트해" `
  --agent pi `
  --model grok-4.3 `
  --workdir D:\alpha-adk\projects\<target> `
  --check "test=pnpm test" `
  --json
```

DeepSeek 분석:

```powershell
naia-agent run "이 설계를 검토하고 위험을 정리해" `
  --agent pi `
  --model deepseek-v4-pro `
  --no-tools `
  --workdir D:\alpha-adk `
  --json
```

기본값을 저장했다면 `--agent`, `--model`, `--no-tools`를 생략할 수 있다.
DeepSeek에 도구가 켜져 있으면 Pi 시작과 Azure 호출 전에 실패한다.

종료 코드:

| 코드 | 의미 |
|---:|---|
| 0 | sub-agent 성공, 지정한 검증 통과 |
| 2 | sub-agent는 끝났지만 검증 실패 |
| 3 | sub-agent 실패·중단·모델 capability 거부 |
| 64 | 명령 인자 오류 |
| 66 | session을 찾거나 읽을 수 없음 |
| 78 | 계정·설정·credential backend 오류 |

`--json` stdout은 기계가 읽는 단일 JSON이다. 진행과 모델 transcript는 stderr로 분리된다.

## 7. 세션

```powershell
naia-agent session list
naia-agent session list --limit 10 --json
naia-agent session show <session-id>
naia-agent session show <session-id> --json
naia-agent session resume <session-id>
```

재개는 기존 transcript의 완결된 `user → assistant` 쌍만 복원하고 같은 session ID에 새 턴을
이어 쓴다. 손상된 줄과 미완결 턴은 제외한다. 한 번에 읽는 크기는 5 MiB, 최근 메시지는
400개로 제한된다. `show` 출력은 표준 secret redaction을 거친다.

## 8. Codex에서 호출

Codex에게 아래 명령을 실행하도록 지시하면 별도 OpenCode 없이 같은 Naia 계정/Pi 경로를 사용한다.

```powershell
naia-agent run "<task>" --agent pi --model grok-4.3 --workdir "<repo>" --json
```

직접 터미널에서 실행할 때와 Codex가 자식 프로세스로 실행할 때 `provider`, `model`,
`workdir`, model evidence, 종료 코드 계약은 같다.

## 9. 하네스북 기준 검증

이 체크리스트는 Naia Harness Book의 다음 원칙을 적용한다.

- 계약: 명령 입력, JSON 출력, 종료 코드가 기계적으로 확인 가능해야 한다
  (`chapter-07-weapon-contract.md:3-13`).
- 파일 책임: 새 `src/main` 파일은 layer/UC/contract anchor를 가져야 한다
  (`chapter-07-weapon-contract.md:118-148`).
- 추적성: 요구→시나리오→기능→테스트가 끊기지 않아야 한다
  (`chapter-09-weapon-traceability.md:3,34-38`).
- 결정론: 실제 LLM 문장 일치가 아니라 provider/model/token/exit 같은 불변식을 검사한다
  (`chapter-10-weapon-verification.md:189-210`).
- 정직성: 자동 검증의 한계와 외부 리뷰 실패를 숨기지 않는다
  (`chapter-10-weapon-verification.md:214-226`).

자동 수용 명령:

```powershell
pnpm build
npx vitest run src/test/cli-manage.contract.test.ts `
  src/test/cli-manage-process.integration.test.ts `
  src/test/cli-chat.contract.test.ts `
  src/test/uc-cli-host-entry.contract.test.ts `
  src/test/uc-naia-pi-cli-process.integration.test.ts
pnpm test
node scripts/check-traceability.mjs
node scripts/check-logging.mjs
node scripts/check-compile-integrity.mjs
node --test src/test/ci-verify-*.test.mjs
```

실계정 smoke의 합격 조건:

1. `auth status --provider naia --json`에서 `authenticated=true`; 키 문자열은 없음.
2. `doctor --json`에서 필수 component에 `fail` 없음.
3. DeepSeek 분석 또는 Grok 코딩 1회가 exit 0.
4. JSON report의 `modelEvidence.provider == "naia"`.
5. `selectedModel`이 요청 모델과 같고 `totalTokens > 0`.
6. DeepSeek negative test는 도구를 켠 상태에서 exit 3이고 upstream 호출 전에 끝남.

LLM이 만든 답변 문구 자체는 합격 조건이 아니다.
