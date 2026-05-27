# naia-agent — 사용자 가이드

> **언어**: [English](../../../docs/user-guide.md) · 한국어 (이 파일)

명령줄에서 `naia-agent` 를 사용하는 짧은 가이드. 두 관점 모두 다룹니다:

- **사용자 본인이 CLI 사용** — `naia-agent …` 직접 타이핑.
- **naia-os shell (또는 임의 호스트)** — any-llm gateway URL 통해 programmatic 호출.

CLI 는 자체 자격증명을 가지고 다니지 않습니다. 모델 = 사용자의 구독 / API 키 / 로컬 서버 (Ollama, vLLM 등). 설정은 **naia-adk** 에 있고 이 레포에는 없습니다.

---

## 빠른 시작 (3 명령)

```bash
# 1) naia-adk 와 모델 지정
pnpm naia-agent login --adk <naia-adk 경로> \
  --main "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"

# 2) 설정 확인 (시크릿 값은 절대 출력 안 됨)
pnpm naia-agent show

# 3) 대화 (native tool-calling 없는 로컬 모델은 --no-tools 추가)
pnpm naia-agent --no-tools "한국어로 한 문장만 인사해줘"
```

(1) 단계 후, `naia-adk/naia-settings/llm.json` 에 설정이 저장됩니다 (provider, baseUrl, model — 키는 절대 X). naia-adk 경로는 `~/.naia-agent/config.json` 에 기억되므로 이후 `NAIA_ADK_PATH` 불필요.

---

## 일반 작업

### 설정 확인

```bash
pnpm naia-agent show
```

한 화면에 표시: 각 role (`main` / `sub` / `embedded`), `llm.json` 위치, 실제 동작할 provider, memory 저장 위치, keychain/env 참조 이름. **시크릿 값은 절대 출력되지 않습니다** — env var 또는 keychain entry 의 *이름* 만.

### 모델 추가/교체

`login` 재실행. 전달하지 않은 role 은 유지됨. 예:

```bash
# embedding 모델만 교체 — main/sub 유지
pnpm naia-agent login --adk <naia-adk 경로> \
  --embedded "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024"
```

### 실 키 사용

키는 OS keychain (Linux 의 경우 libsecret) 에 저장되며, **평문으로 저장되지 않습니다**. `llm.json` 은 keychain entry 의 *이름* 만 담음.

```bash
pnpm naia-agent login --adk <naia-adk 경로> \
  --main "anthropic|https://api.anthropic.com|claude-haiku-4-5|ANTHROPIC_API_KEY" \
  --key ANTHROPIC_API_KEY=sk-ant-…
```

OS keychain 이 가용하지 않으면 `login` 은 키 영속화를 *거부* 하고 (평문 fallback X) shell 의 `export` 사용을 안내합니다.

### 영속 메모리 대화

`--memory` 추가. 한 프로세스에서 말한 사실을 다음 프로세스에서 회상 (cross-session SQLite).

```bash
pnpm naia-agent --no-tools --memory \
  "내 이름은 루크고, 가장 좋아하는 음료는 보리차야."

# 나중에 새 프로세스:
pnpm naia-agent --no-tools --memory \
  "내가 제일 좋아하는 음료가 뭐였지?"
```

메모리는 기본적으로 `~/.naia-agent/memory/cli.sqlite` 에 저장. workspace 별 분리는 `NAIA_AGENT_MEMORY_DB` 환경변수.

### REPL 모드

`pnpm naia-agent` (프롬프트 없이) → REPL (`naia> `) 진입. `exit` (또는 Ctrl-D) 로 종료. REPL 은 단일 turn 실패에 견딥니다 — 모델 서버 다운 시 hint 출력 후 다시 prompt 표시.

Pipe-fed REPL (Slice 3-XR-M) — stdin 이 piped 상태여도 `--repl` 로 REPL 모드 강제. 쉘 파이프라인이 다턴 입력 feeding 시 유용:

```bash
printf "hi\nstill there?\nexit\n" | pnpm naia-agent --no-tools --repl
```

### ADK skills 사용 (naia-adk, onmam-adk 등)

`--skills-dir <path>` 플래그 (Slice 3-XR-J) 는 외부 ADK 의 top-level `skills/` 디렉토리를 로드하여 `CompositeToolExecutor` 로 bash + file-ops 와 결합. 이름 충돌 시 first-registered wins — sub 순서가 trust boundary.

```bash
# naia-adk 시스템 skills (19) — time, weather, channel-management 등
pnpm naia-agent --enable-file-ops --skills-dir projects/naia-adk/skills \
  --system "You can use time, weather, channel-management, etc." \
  "What time is it in Seoul?"

# onmam-adk 도메인 skills (10 + wp-archive)
pnpm naia-agent --enable-file-ops --skills-dir projects/onmam-adk/skills \
  "summarize the wp-archive skill"
```

Tool invocation 은 stderr 에 `[tool] <name>({args})` 형식으로 출력 — grep 가능.

### 평가 하네스 직접 실행

```bash
# 전체 통합 suite (53+ 시나리오, Groups A/B/C/D/E/F/G/H/I/M/N/O/P/K)
pnpm --filter @nextain/agent-cli-app exec vitest run \
  src/__tests__/integration-scenarios.test.ts

# 단일 그룹
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group P"   # pi-coding LIVE
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group D"   # naia-adk skills
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group G"   # onmam-adk

# 3-judge ensemble (GLM + Claude CLI + Codex CLI) — 크레딧 소비!
NAIA_JUDGE_ENSEMBLE=1 \
  pnpm --filter @nextain/agent-cli-app exec vitest run -t "A1|A4|F2"
```

결과는 `.agents/progress/integration-scenarios-results-2026-05-20.json` 에 (시나리오별 verdict + judge breakdown + observed tail), prose 요약은 `integration-scenarios-report-2026-05-20.md`. 전체 리스트 (tier 비교, cross-OS sanity, recall bench 등) 는 프로젝트 메인 README 의 "벤치마크 + 시나리오 직접 실행" 섹션 참조.

---

## naia-os shell / gateway 관점

호스트 (예: naia-os shell) 는 any-llm gateway 통해 라우팅. naia-agent 입장에서 gateway 는 단순 openai-compatible endpoint:

```bash
pnpm naia-agent login --adk <naia-adk 경로> \
  --main "openai-compat|https://your-gateway.example/v1|your-model|GATEWAY_API_KEY"
```

`show` 는 gateway URL 과 `apiKeyRef=GATEWAY_API_KEY` *이름* 만 출력; 키 값은 OS keychain 또는 shell env 에 있음.

---

## 문제 해결

**"no LLM provider configured" / exit 3**
`naia-agent login --adk …` 실행 (위 참조), 또는 hosted provider 의 env var (예: `ANTHROPIC_API_KEY`) 설정.

**"turn failed — … unreachable"**
모델 서버 미가동 또는 URL 오류. 시동, 또는 다른 baseUrl 로 re-`login`.

**"does not support tools"**
모델이 native tool-calling 미지원 (예: 로컬 gemma3n). `--no-tools` 추가. naia-agent 가 자동 hint.

**`<recal…>` 텍스트가 응답에 누출**
소형 모델이 malformed recall marker 를 발하는 경우. agent 가 응답을 sanitize; 드물게 letter-drop variant 가 빠져나갈 수 있는데 = 소형 모델 한계 (코드 결함 X).

---

## 프라이버시 & 시크릿

- `naia-adk/naia-settings/llm.json` 은 **git-tracked**; provider/url/model 만 담음. reader 가 raw secret 을 포함한 파일을 적극 *거부*.
- 키는 OS keychain (libsecret, device-key 암호화) 또는 shell env. naia-agent 는 키를 디스크에 쓰지 않음.
- `show` 는 reference *이름* 만 출력; 값은 절대 표시 안 됨.

---

## ADK 생태계 (advanced)

`naia-agent` 는 **뼈대 (runtime skeleton)**; ADK 패키지의 skills 를 사용. 통합 동작은 Slice 3-XR-G/J/L 로 검증:

| ADK | 통합 방식 | 시나리오 |
|---|---|---|
| `naia-adk` | `FileSkillLoader` + `SkillToolExecutor` (`--skills-dir`) | Group D (LIVE 24G, 19/19 시스템 skills) |
| `naia-business-adk` | `--service <manifest>` `backend:"langgraph"\|"rag-retriever"` | Group E (reserve stub graceful; live = Slice 3-XR-K 로 deferred) |
| `naia-os` | `--system "<persona text>"` 페르소나 주입 | Group F (LIVE 24G ✅) |
| `onmam-adk` | `naia-adk` 와 동일 import 경로 (도메인 skills) | Groups D/G (메커니즘 reuse) |

전체 결과: `.agents/progress/integration-scenarios-report-2026-05-20.md`.

## 페르소나 주입 (`--system`)

naia-os 가 페르소나 inject 시 사용하는 인터페이스. CLI 에서도 직접 사용 가능:

```bash
pnpm naia-agent --no-tools --no-default-system \
  --system "You are a soft-spoken Korean voice assistant. Be brief." \
  "안녕하세요?"
```

- 페르소나는 `--memory` 와 합성 가능 (F2 검증). 페르소나 톤 유지하면서 cross-process 회상 동작.
- 페르소나 ≤ 4KB 검증 (F4).
- thinking-mode 모델 (예: Gemma 4) 사용 시 페르소나에
  `Answer directly. Do not write any internal reasoning.` 라이더 합성 시 깨끗.

---

## 위치 ledger

| 파일 | 소유 | 목적 |
|---|---|---|
| `<naia-adk>/naia-settings/llm.json` | naia-adk | LLM 설정 정본 (3 roles) |
| `~/.naia-agent/config.json` | naia-agent | 영속화된 `naiaAdkPath` |
| `~/.naia-agent/memory/cli.sqlite` | naia-agent | `--memory` 저장소 |
| OS keychain (libsecret) | OS | 암호화된 키 값 |

---

## 헷갈릴 때

```bash
pnpm naia-agent              # usage + subcommands
pnpm naia-agent show         # 현재 설정
pnpm naia-agent login        # login usage
```

---

## 계획 / 미출시 (deferred)

프로젝트 로드맵에는 있지만 현 시나리오 테스트에 포함되지 않은 항목:

- **RBAC tier policy / approval broker UX** — runtime 은 tiers (T0–T3) + `ApprovalBroker` 지원, 그러나 end-to-end CLI 시나리오 미작성.
- **Claude Code subscription routing** — bin 은 `--service <manifest>` 와 `backend:"claude-code"` (API key X, Claude Code CLI OAuth) 수용. DRYRUN dispatch 는 시나리오 G3 (`NAIA_AGENT_DRYRUN=1`) 가 검증; live-subscription E2E 는 deferred (Claude Code 크레딧 소비).
- **SDLC artifact production** (실 코딩 / specs / docs) — 강 코딩 모델 필요; 8G/24G 로컬 프로파일은 채팅 가능하지만 SDLC-grade artifact 는 신뢰성 부족. plan: strong backend (claude-code subscription / gateway-hosted Anthropic / Codex) 가 `main` 에 설정된 경우 활성화.
- **3-XR-Voice (#28) = P0c-2** — Voice 오케스트레이션은 naia-os + naia-omni 영역. naia-agent는 LLM 텍스트 턴만 담당 (voice I/O 없음). P0c-2 통합 작업은 별도 세션에서 naia-os 주도로 진행.
