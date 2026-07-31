# Issue #97 — First-class naia-agent CLI

## Goal

`naia-agent`를 단순 채팅 진입점이 아니라, 사용자가 Naia 계정으로 모델을 선택하고
설정·진단·세션을 관리하며 Pi 코딩 작업을 실행할 수 있는 독립 CLI로 만든다.
Codex가 자식 프로세스로 호출하는 경로와 사용자가 직접 호출하는 경로는 같은 명령과
설정을 사용한다.

이 문서는 `REQ-020 → UC-023 → SPEC-019 → TEST-S-020 / TEST-F-019`의 권위 계약이다.
GitHub issue: <https://github.com/nextain/naia-agent/issues/97>

## Scope and boundary

포함:

- `naia-agent auth status|login|logout`
- `naia-agent config list|get|set|reset`
- `naia-agent models [provider] [--json]`
- `naia-agent doctor [--json]`
- `naia-agent session list|show|resume`
- `naia-agent login`·`workspace` 기존 명령의 호환 alias
- 기존 `run`의 Pi 기본값 적용과 동일한 Codex-child/direct-user 동작
- 격리된 HOME에서의 UC/FE/process 통합 테스트와 실제 Naia 계정 smoke

제외:

- naia-shell의 코딩 Workspace UI와 coding worker lifecycle
- OAuth/browser login 서버 신설
- OpenCode 호환 설정 파일 또는 OpenCode runtime 의존
- DeepSeek의 도구 코딩 허용(분석 전용 정책 유지)
- 다중 모델 자율 계획·합의 오케스트레이션

## P01 — user scenario

### Happy path

1. 사용자는 `naia-agent auth login --provider naia`를 실행한다.
2. 터미널이 TTY이면 키 입력은 화면에 표시되지 않는다. 키는 Windows DPAPI 또는
   Linux secret-tool에 저장되며 평문 파일 fallback은 없다.
3. `auth status`는 provider별 로그인 여부와 출처만 보여 주고 키 값은 보여 주지 않는다.
4. 사용자는 `models`로 Naia에서 쓸 수 있는 모델과 도구 지원 여부를 확인한다.
5. `config set coding.agent pi`, `config set coding.model grok-4.3`으로 기본값을 저장한다.
6. 이후 `naia-agent run "<작업>"`은 명시 플래그 없이도 같은 Pi/모델을 사용한다.
7. `doctor`는 계정·워크스페이스·Pi·모델 경로의 준비 상태를 한 번에 진단한다.
8. 채팅 transcript는 세션 명령으로 목록·조회되고 `session resume <id>`가 완결된
   user/assistant 기록을 복원해 동일 코어에서 다음 턴을 이어 간다.

### Failure and safety path

- 비대화형 로그인은 `--key` 또는 stdin을 요구하며 영구 대기하지 않는다.
- `logout`은 선택한 provider 키만 제거하고 다른 provider와 주석은 보존한다.
- 기존 `~/.naia-agent/.env`는 읽기 호환만 제공한다. 새 login 성공 시 같은 provider의
  legacy 줄을 제거하고, keychain을 쓸 수 없으면 저장하지 않고 실패한다.
- config는 allowlist key와 타입만 허용하고 비밀값을 받지 않는다.
- config와 DPAPI blob은 같은 디렉터리의 임시 파일을 거친 atomic rename으로 교체한다.
- JSON 출력은 자동화 가능한 안정된 구조이며 secret을 포함하지 않는다.
- gateway/catalog 장애 시 `models`와 `doctor`는 실패 원인을 구분하고, 검증된 내장
  Naia Pi 카탈로그로 제한적으로 진단을 계속한다.
- 손상된 session JSONL은 유효한 줄까지만 읽고 경로 탈출 ID는 거부한다. 파일 5 MiB,
  최근 400 message를 상한으로 하며 show/JSON의 흔한 credential 문자열은 redaction한다.
- `deepseek-v4-pro`는 기본값으로 저장돼도 `run`에서 `--no-tools`가 없으면 기존처럼
  Pi spawn 전에 실패한다.

## P02 — Test Coverage Map

| ID | Layer | Automated evidence | Acceptance |
|---|---|---|---|
| UC20-01 | UC | CLI process integration with isolated HOME | auth→config→models→doctor→session 전체 흐름, exit/output 검증 |
| UC20-02 | UC | real Naia smoke | 저장된 계정으로 Grok 또는 DeepSeek 1회, provider/model/token evidence |
| FE19-01 | FE | management parser/config contract | command grammar, allowlist/type, reset, legacy aliases |
| FE19-02 | FE | credential contract | hidden-input seam, DPAPI/secret-tool write/delete, legacy migration, redaction, empty/non-TTY failure |
| FE19-03 | FE | model/doctor contract | catalog normalize/fallback, capability, component status, JSON schema |
| FE19-04 | FE | session contract/integration | safe ID, list/show, corrupt-line tolerance, resume history |
| FE19-05 | FE | run-default contract/process | config defaults < explicit flags, DeepSeek fail-closed, Codex/direct parity |
| PROC19-01 | Process | structure/SDLC/traceability/logging/i18n gates | 모든 정책 검사 통과 |
| REG19-01 | Regression | full `pnpm test` + build | 기존 suite 회귀 0 |

## P03 — Feature design

### Ownership

- `src/main/app/cli-manage.ts`: Node I/O가 없는 명령 파싱, config schema, credential text
  변환, model/session/doctor 표현 모델. `SPEC-019`의 순수 application policy.
- `bin/naia-agent-manage.mjs`: filesystem, stdin/TTY, OS keychain, HTTP, executable discovery를
  주입하는 host. keychain 불가 시 평문 fallback 없이 실패한다.
- `bin/naia-agent.mjs`: command family dispatcher만 담당한다.
- `bin/naia-agent-chat.mjs`: 기존 채팅 core 배선을 유지하고 session resume 시 검증된 history만
  초기값으로 주입한다.
- `bin/naia-agent-run.mjs`: CLI config의 coding 기본값을 읽되 명시 argv가 항상 우선한다.

### Configuration schema

`~/.naia-agent/config.json`은 workspace 포인터만 소유한다. 코딩 기본값은 정본 규칙에 따라
`<workspace>/naia-settings/cli.json`(atomic replace)에 둔다:

```json
{
  "coding": {
    "agent": "pi",
    "model": "grok-4.3",
    "tools": true
  }
}
```

허용 key는 `workspace`, `coding.agent`, `coding.model`, `coding.tools`뿐이다. `workspace`는 전역
포인터에, `coding.*`는 현재 workspace의 `naia-settings/cli.json`에 기록한다.
워크스페이스의 provider/model 정본인 `naia-settings`는 복제하지 않는다.

### Session contract

기존 코어가 쓰는 `<workspace>/conversations/<session-id>.jsonl`을 그대로 읽는다.
새 session database를 만들지 않는다. `resume`은 마지막 완결 user/assistant 쌍만 복원하며,
새 턴도 같은 session ID에 append한다. ID는 기존 `sessionFileName` 정책과 동일한 ASCII
allowlist를 통과해야 한다. read는 5 MiB/최근 400 message로 bounded하고, show 출력은
표준 `redactSecrets`를 거친다.

### OpenCode reference decisions

채택:

- `models [provider]`, machine-readable JSON
- provider credential list/logout
- bounded recent session list와 JSON 출력
- 명시 플래그가 저장 기본값보다 우선하는 실행 UX

채택하지 않음:

- OpenCode DB/provider registry 복제
- full-screen TUI
- OpenCode auth/config file 호환

## Planning adversarial review

`review-pass` planning reviewer 호출 결과:

- Gemini: Vertex credential 환경 부재로 시작 전 실패.
- Claude: 두 차례 모두 turn/time budget 안에 결과 미반환.
- Codex: read-only 호출이 time budget 안에 결과 미반환.
- Naia Pi/Grok read-only 시도: exit 0이나 finding text/model evidence 미반환으로 유효 리뷰가 아님.

따라서 리뷰 결과를 CLEAN으로 간주하지 않고 degraded로 기록했다. 주 에이전트가 독립 primary
evidence gate를 수행해 다음 finding을 수용했다.

| Claim | Primary evidence | Status | Design action |
|---|---|---|---|
| 새 login이 `.env` 평문을 계속 쓰면 REQ-102와 충돌 | `keychain-secret-store.ts`; `compose-agent-deps.mjs` DPAPI/secret-tool read; REQ-102 | ACCEPTED | OS keychain write/delete, legacy read+migration only |
| session 전체 read는 메모리·출력 폭증 위험 | append-only `conversation-log-store.ts`, 기존 size cap 없음 | ACCEPTED | 5 MiB/400 message bound |
| session show가 대화에 포함된 key를 재출력할 수 있음 | transcript는 verbatim append | ACCEPTED | 표준 redactor 적용 |
| catalog fallback이 실시간 목록처럼 보이면 오도 | Pi 내장 목록은 2개 고정 | ACCEPTED | `source=live|fallback`, warning 명시 |
| config 직접 write는 crash 시 손상 가능 | 기존 config write는 direct write | ACCEPTED | temp+atomic rename |
| 전역 home에 coding.model을 두면 workspace 설정 정본 규칙 위반 | `.agents/context/canon-scope.json` storage.canonical | ACCEPTED | coding 기본값을 workspace `naia-settings/cli.json`으로 이동 |

위 finding은 문서와 현재 코드의 직접 증거로 재현됐다. 외부 reviewer 가용성 문제는 통합 단계에서
다시 시도하며, 구현·테스트의 수용 기준을 낮추지 않는다.

## Review and completion record

- Planning review: degraded external tools; 5 primary-evidence findings accepted and spec updated
- Development review: plaintext credential, unbounded transcript, secret-bearing show, misleading catalog fallback,
  non-atomic config, credential precedence, explicit-agent/stored-model coupling, and global coding-setting ownership
  findings were fixed. A final Naia/Grok adversarial review timed out without findings and was not counted as clean.
- Test review: build plus 128 test files passed; 1,424 tests passed and 9 opt-in environment tests skipped.
  Traceability reported 22 REQ, 17 UC, 19 TEST-S, 19 SPEC, 19 TEST-F with zero dead links and zero orphans.
- Integration review: isolated HOME process tests exercised Windows DPAPI login/status/logout, allowlisted global/workspace
  config, catalog fallback, doctor, transcript redaction/resume, and explicit run precedence. The real account reported
  `authenticated=true`, `source=dpapi`; DeepSeek returned exit 0 with `provider=naia`,
  `selectedModel=deepseek-v4-pro`, and 7,609 total tokens. The intentional tools-on negative path was rejected before
  upstream execution.
- Manual reader test: a clean-user pass followed sections 1, 3, 5, 6, and 9 without hidden setup. The only operational
  warning was `/v1/models` returning an empty catalog; the manual already distinguishes `source=fallback` from live data.
- Verification skill maintenance: no new generic verify skill was created because the deterministic contract/process
  tests are the executable guard. The workspace `verify-i18n` skill still references removed paths
  (`packages/runtime/src/i18n`, `bin/naia-agent.ts`) and is not applicable to this `.mjs` CLI; this drift is reported
  rather than treated as a pass.
- Baseline governance drift: `check-file-anchors` still reports 29 pre-existing files and
  `check-canon-conformance` reports 57 pre-existing scope entries. The new `cli-manage.ts` is present in the module
  manifest under UC-023/SPEC-019 and appears in neither failure list. These unrelated ownership records were not
  guessed or bulk-rewritten.
- PR #98 preflight: the protected context change uses the user-authorized `charter-approved` label. The remaining
  GitHub failures happen before this feature's tests: `pnpm/action-setup` receives both workflow `version: 10` and
  `packageManager: pnpm@10.33.0`, while OSS readiness reports 18 unchanged baseline paths/URLs. The PR diff contains
  none of the reported OSS files; local build, full test suite, and targeted policy gates remain the merge evidence.
- P04 integration: done
- P05 completion: done
