<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# naia-agent에 기여하기

> naia-agent는 naia의 **뇌**입니다 — 대화를 처리하고, 기억을 떠올려 답에 반영하고, 도구(스킬)와 대규모 언어 모델(LLM)을 연결하는 런타임입니다.
> 셸(naia-os)이 gRPC로 메시지를 던지면, 이 런타임이 *기억 회상 → LLM 호출 → 저장*을 처리해 결과를 돌려줍니다.
> 이 문서는 처음 오신 분이 "무엇을, 어떻게" 도울 수 있는지 안내합니다.

## 처음이라면 — 가장 빠른 첫 기여 (15분)

위에 "gRPC"·"런타임" 같은 말이 나와도 겁먹지 마세요. **첫 기여에는 그런 걸 몰라도 됩니다.**
오타·문서·번역·작은 버그·테스트 보강 같은 작은 변경은 아래 게이트(P01~P05)를 거치지 않고 이슈 하나면 됩니다. naia-agent는 **순수 Node.js**라 Rust 같은 무거운 도구도 필요 없습니다.

준비: [Node.js](https://nodejs.org/) 22 이상 설치 → `corepack enable && corepack prepare pnpm@9 --activate`(pnpm 켜기) → (`naia-memory` 함께 clone — 아래 [5. 개발 환경 준비](#5-개발-환경-준비) 참고) → `pnpm install`. 확인: `node -v`, `pnpm -v`.

AI 코딩 도구(Cursor, Claude Code 등)를 쓰신다면, 이 폴더를 연 뒤 아래를 그대로 복사해 붙여 보세요:

> 이 저장소의 `.github/CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `.agents/context/agents-rules.json` 을 읽고,
> gRPC·헥사고날 구조를 몰라도 할 수 있는 'good first issue' 후보 3개를, 각각 어떤 파일을 고치면 되는지와
> 그 변경이 게이트(P01~P05)가 필요한지까지 함께 알려줘.

막히면 [Discord](https://discord.gg/FGYJN7auty)에서 물어보세요.

## 1. 누구의 허락도 필요 없습니다

먼저 저장소를 내려받습니다.

```bash
git clone https://github.com/nextain/naia-agent.git
cd naia-agent
```

그다음 사용하는 AI 코딩 도구(Claude Code, Cursor, GitHub Copilot, Gemini CLI 등)에서 이 폴더를 열고, 모국어로 이렇게 물어보세요.

> 이 프로젝트는 무엇이고, 제가 처음으로 도울 수 있는 일은 무엇인가요?

저장소의 [`.agents/`](../.agents/) 디렉토리에는 프로젝트의 비전·구조·규칙이 정리돼 있습니다. AI 도구가 이 내용을 읽고 **당신의 언어로** 설명해 줍니다. 그래서 문서를 처음부터 끝까지 읽지 않아도 시작할 수 있습니다.

막히면 [Discord](https://discord.gg/FGYJN7auty)에서 물어보세요. 가장 빠르게 도움을 받을 수 있습니다.

## 2. 어떤 언어로 참여해도 됩니다

- **이슈, 풀 리퀘스트(Pull Request, 이하 PR), 토론** — 어떤 언어로 써도 됩니다. 메인테이너가 AI 번역으로 읽습니다.
- **코드 주석, 커밋 메시지, [`.agents/`](../.agents/) 컨텍스트 파일** — 영어를 권장합니다. 영어 작성이 어렵다면 모국어로 제출해도 됩니다. 리뷰 과정에서 메인테이너가 영어 표현을 함께 다듬습니다.

## 3. 이 프로젝트의 핵심 — "스스로 점검하는 구조(하네스)"

naia-agent는 코드 대부분을 AI가 작성하는 프로젝트입니다. AI가 만든 코드는 빠르게 나오지만, 요구사항을 놓치거나 프로젝트 구조를 어길 수 있습니다. 그래서 사람이 매번 기억해서 확인하는 대신, **문서로 정한 절차와 자동 점검 스크립트**로 품질을 지킵니다. 이 묶음(절차 문서 + 체크리스트 + 점검 스크립트)을 이 프로젝트에서는 **하네스(harness)**라고 부릅니다.

기여 규칙도 여기서 나옵니다. 처음에는 낯설어 보여도, 이 구조가 있어야 사람이든 AI든 한 조각씩 안전하게 고칠 수 있습니다.

- **개발 절차 게이트 (P01~P05)** — 코드를 바로 쓰기 전에 *시나리오 → 테스트 계획 → 요구사항*을 먼저 적습니다. 자세한 단계는 아래 [6. 코드 기여 절차](#6-코드-기여-절차)에 있습니다.
- **구조 규칙 (F12·F13)** — 프로젝트 최상위 폴더(루트)에는 미리 허용된 파일·디렉토리만 둘 수 있습니다. 새 파일이 필요하면 규칙에 먼저 등록합니다.
- **헌장(charter) 문서** — [`AGENTS.md`](../AGENTS.md), [`agents-rules.json`](../.agents/context/agents-rules.json), [`project-structure.md`](../docs/project-structure.md) 같은 핵심 규칙 문서는 AI가 단독으로 바꿀 수 없고, 사람의 승인이 필요합니다.

> 처음이라면 [`AGENTS.md`](../AGENTS.md) → [`agents-rules.json`](../.agents/context/agents-rules.json) → [`project-structure.md`](../docs/project-structure.md) 순서로 읽어 보세요. 전체 구조는 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)에 정리돼 있습니다.

## 4. 기여하는 방법

코드만 기여가 아닙니다. 아래 어느 한 곳에서 시작하면 됩니다.

| 기여 유형 | 난이도 | 시작 위치 |
|---|---|---|
| 번역 | 낮음 | [`.users/context/`](../.users/context/)에 언어 추가 (초벌은 자동 번역이 만들어 줍니다) |
| 버그 리포트 | 낮음 | [GitHub Issues](https://github.com/nextain/naia-agent/issues) 에 재현 절차와 함께 등록 |
| 문서 개선 | 낮음 | [`docs/`](../docs/), [`.users/`](../.users/) |
| 테스트 보강 | 중간 | 계약·통합 테스트 추가 ([`src/test/`](../src/test/)) |
| 코드 / PR | 중간~높음 | 아래 [6. 코드 기여 절차](#6-코드-기여-절차) 참고 |
| 컨텍스트 개선 | 중간 | [`.agents/`](../.agents/) 의 규칙·설명 다듬기 — 좋은 컨텍스트 하나가 저품질 AI PR 100건을 막습니다 |

> **보안 취약점**은 공개 이슈에 올리지 말고, [보안 정책](SECURITY.md)에 따라 `security@nextain.io`로 비공개 제보해 주세요.

## 5. 개발 환경 준비

naia-agent는 **순수 Node.js 런타임**입니다(셸과 달리 Rust·Tauri가 필요 없습니다).

**준비물**

- [Node.js](https://nodejs.org/) 22 이상, [pnpm](https://pnpm.io/) 9 이상

**설치와 실행**

```bash
pnpm install   # 의존성 설치 (naia-memory 함께 clone 필요 — 아래 참고)
pnpm build     # 타입스크립트 빌드 (tsc -p tsconfig.json)
pnpm test      # 단위·계약 테스트 (vitest)
```

> ⚠️ **`naia-memory` 를 아래 레이아웃으로 함께 clone.** `package.json` 의
> `@nextain/naia-memory` 의존이 로컬 경로 `file:../../naia-memory`(naia-agent 에서 **두 단계 위**)라,
> **naia-agent 의 조부모 디렉토리**에 `naia-memory` 가 있어야 `pnpm install` 이 성공합니다.
>
> ```bash
> mkdir naia-stack && cd naia-stack
> git clone https://github.com/nextain/naia-memory.git
> git clone https://github.com/nextain/naia-agent.git dev/naia-agent
> #   naia-stack/naia-memory  +  naia-stack/dev/naia-agent  ← 여기서 pnpm install
> cd dev/naia-agent
> ```

**구조 점검 (코드 작성 전에 한 번)**

```bash
./scripts/enforce-root-structure.sh             # 루트 구조 규칙을 "확인만" 합니다 (변경 없음)
node --test src/test/ci-verify-*.test.mjs       # 구조·헌장·개발 절차(SDLC)·완전성 검사
```

> ⚠️ `enforce-root-structure.sh --fix`는 규칙에 등록되지 않은 루트 파일·폴더를 **삭제**합니다. 작업 중인 파일이 날아갈 수 있으니 커밋하지 않은 변경이 있을 땐 쓰지 마세요. 평소엔 `--fix` 없이 확인만 하면 됩니다.

## 6. 코드 기여 절차

코드를 바로 작성하기 전에 다음 순서를 따릅니다. 이 순서를 **개발 절차 게이트(P01~P05)**라고 부릅니다. 이 절차는 **코드를 바꾸는 PR**에 적용됩니다 — 작은 문서 수정이나 번역처럼 코드 동작에 영향이 없는 기여는 필요한 단계만 따르면 됩니다. 코드 변경에서는 각 단계의 산출물을 먼저 남기는 것을 원칙으로 합니다.

| 단계 | 할 일 | 산출물 |
|---|---|---|
| 0 | 작업할 이슈를 고르거나 새로 등록 | [GitHub Issue](https://github.com/nextain/naia-agent/issues) |
| P01 | 사용자 시나리오(누가·무엇을·왜) 작성 | [`docs/user-scenarios.md`](../docs/user-scenarios.md) |
| P02 | 무엇을 테스트할지 계획 (위 파일의 Test Coverage Map) | 같은 파일 |
| P03 | 기능 요구사항(Functional Requirement, FR)·비기능 요구사항(Non-Functional Requirement, NFR) 작성 | [`docs/requirements.md`](../docs/requirements.md) |
| 구현 | 코드 작성 (새 파일·폴더는 구조 규칙에 먼저 등록) | — |
| P04 | 테스트 작성·실행 | 테스트 파일 (`src/test/*.contract.test.ts` 등) |
| P05 | 완료 표시 (요구사항 상태를 Done으로) | [`docs/requirements.md`](../docs/requirements.md), [`process-status.json`](../.agents/context/process-status.json) |
| PR | 풀 리퀘스트 제출 | 제목 형식 `type(scope): 설명` |

**PR 체크리스트**

- [ ] 시나리오·테스트 계획·요구사항(P01~P03)을 먼저 적었다
- [ ] 테스트를 포함했고 통과한다 (`pnpm test`)
- [ ] 새 파일·디렉토리를 구조 규칙에 등록했다
- [ ] 헌장 문서를 임의로 바꾸지 않았다
- [ ] 커밋 메시지를 영어로, `type(scope): 요약` 형식으로 썼다

## 7. AI 도구 사용

AI 도구 사용을 환영하고 권장합니다. 사용했다면 커밋 메시지 끝에 어떤 도구를 썼는지 적어 주세요(권장, 필수는 아닙니다).

```
feat(memory): 대화 회상 기능 추가

Assisted-by: Claude Code
```

`Assisted-by:` 뒤에는 사용한 도구 이름을 적습니다 (예: `Claude Code`, `ChatGPT`, `Cursor`, `Gemini`).

## 8. 더 깊은 주제

naia-agent는 **헥사고날(hexagonal, 포트·어댑터) 구조**로 되어 있습니다. 핵심 로직은 바깥세상(파일·네트워크)을 모르고, 경계(포트)와 그 구현(어댑터)으로만 연결됩니다.

- **헥사고날 레이어** — `domain/`(순수 로직, 입출력 없음) · `app/`(흐름 조율) · `ports/`(경계 인터페이스) · `adapters/`(외부 연결 구현) · `composition/`(조립)
- **제공자(provider) 라우팅** — 어떤 LLM으로 보낼지 고르고 호출하는 부분
- **기억(naia-memory) 연동** — 대화를 떠올려 답에 반영하고, 새 대화를 저장하는 부분
- **naia-os ↔ naia-agent 경계(wire) 계약** — 셸(naia-os)과 런타임(naia-agent)이 gRPC로 주고받는 메시지 형식

자세한 설계는 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)를 참고하세요. 작업을 시작하려면 [GitHub Issues](https://github.com/nextain/naia-agent/issues)에 제안 이슈를 먼저 열거나 [Discord](https://discord.gg/FGYJN7auty)에서 문의해 주세요.

## 9. 보상

naia-agent는 아직 초기 단계 오픈소스라 바운티나 보상 프로그램이 없습니다. 지금의 모든 기여는 자발적인 참여입니다.
프로젝트와 회사가 자리를 잡으면 기여자 보상(버그 바운티·기능 바운티)을 도입할 계획입니다. 작은 기여라도 진심으로 감사드립니다.

## 10. 라이선스

- **소스 코드** — [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- **AI 컨텍스트** (`.agents/`, `.users/`, `AGENTS.md` 등) — [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

기여하시면 위 라이선스 조건에 동의하는 것으로 간주합니다.
