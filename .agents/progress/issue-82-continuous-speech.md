---
session_id: "03b17f74-14d6-4390-a3ed-871d373001cf"
prior_session_id: "08e07adf-cb54-4aab-81af-951410c386b7"
---

# Issue #82 — 자유 발화와 연속 발화

## 2026-07-18 구현·검증 완료 — 현재 정본

- 상태: ✅ **두 MVP profile 구현 및 development/integration 적대 리뷰 CLEAN.**
- 구현:
  - `personal_radio_dj`: 명시적 opt-in, 시간·동의된 최신 날씨·명시적 취향 근거,
    구조화된 YouTube BGM 성공 확인, music-only/talk-less/talk-more/change-vibe/next/stop,
    안전 lease 자동 갱신과 늦은 재생 보상.
  - `exhibition_intro`: 지정 KB의 source 필수 소개, 비반복 cursor, 근거 없을 때 기권,
    질문 시 단일-use yield/resume binding, Q&A memory/transcript 우회, quiet/restart/stop.
  - 공통 wire/shell: profile 설정·장기 activity 구독·yield/control/stop RPC,
    proactive TTS와 panel BGM, ordinary Chat 끼어들기, stale generation 폐기,
    Live/omni와 activity 음성 lane 상호배제.
- 적대 리뷰 수렴:
  - 계획: 개인 DJ CLEAN + 행사 소개 CLEAN.
  - 개발/통합: profile-session 결속, BGM 3중 식별자, reconnect 종료,
    single-use yield 순서, TTS TOCTOU, Live 연결 및 mic 권한 경쟁조건을 수정한 뒤
    개인 DJ **CLEAN**, 행사 소개 **CLEAN**.
  - OpenRouter/OpenCode `opencode/hy3-free`: agent 범위 CLEAN. shell finding은
    실제 Rust dispatcher/profile session 배선과 대조해 오탐을 기각했고, 유효했던 reconnect/parser
    finding은 수정했다.
- 검증:
  - naia-agent 전체: **84 files, 1,002 passed, 8 skipped** + TypeScript build PASS.
  - naia-shell 전체: **110 files, 1,200 passed, 13 skipped** + focused 37 tests +
    TypeScript/Vite production build PASS.
  - Rust: `cargo check` PASS (기존 dead-code warning 8건).
  - import boundary: 새 공유 계약을 `ports/speech-activity.ts`로 이동 후 PASS.
  - conflict marker 없음, i18n 신규 적용 대상 없음, 신규 비영어 문자열은 발화 명령
    parser vocabulary이며 사용자 표시 하드코딩이 아님.
- `manage-skills` 판단: 이번 불변조건은 이 기능의 contract/integration 테스트가 직접 고정한다.
  워크스페이스 전역의 반복 검증 규칙은 아니므로 새 verify skill을 만들지 않는다.

## 2026-07-18 목표 재정렬 및 planning 수렴 — 구현 전 정본

- 당시 상태: 🟢 **두 MVP profile planning CLEAN. RED 테스트·구현 단계로 전환.**
- 우선순위:
  1. `personal_radio_dj` — Luke 개인 라디오 DJ
  2. `exhibition_intro` — 회사 전시 행사 소개
- 권위 계약:
  `docs/progress/99.dev-comm/UC-CONTINUE-SPEAKING-contract-2026-07-16.md` §0
- 교차 리뷰:
  - Goal 1 1차 FINDINGS 11건 → 보완 → 잔여 3건 → 보완 → **CLEAN**
  - Goal 2 1차 FINDINGS 12건 → 보완 → 잔여 3건 → 보완 → **CLEAN**
- 핵심 확정:
  - DJ: app-owned idle, 좁은 BGM opt-in, `RadioDjBgmPort`, source/freshness snapshot,
    app-owned 안전 템플릿, music-only/talk-less/change-vibe/next/stop, bounded auto-renew lease.
  - 전시: read-only KB port, source 필수/기권, non-repeat cursor, non-terminal yield →
    profile-bound Q&A → resume, memory/transcript off.
  - wire: `ConfigureSpeechProfile`, `SubscribeSpeechActivities`,
    `YieldSpeechActivity`, `StopSpeechActivity`, `activityResume`.
  - shell: unsolicited activity와 ordinary Chat ref 분리,
    `interruptTts → yield → Chat`, stale activity audio/text 폐기.
- 기존 AC1~AC18의 범용 취소·저장소 quarantine·chunk 상한은 후속 hardening이다.
  DJ-01~07/DJ-GRPC-01과 EX-01~06/SHELL-01이 먼저 구현 게이트다.

아래 2026-07-17 내용은 설계 변화 이력이다. 위 현재 정본과 충돌하면 위 절을 따른다.

- 과거 상태: v3 하이브리드 — 경첩 실측 1차 완료(GO 조건부, ②-only 신규 구멍)
- v3 패널 증적: `.agents/reviews/issue-82-planning-v3-2026-07-17.json` (수렴 findings 7건 + 생존 5건 + codex AC1~18 재작성 표)
- 경첩 실측 증적: `.agents/reviews/issue-82-v3-evidence-hinge-2026-07-17.json` + 재실행 스크립트 `benchmark/v3-evidence-probe.mjs`
- 다음: ① **②-only 방어 2차 실측**(설명 강화 + 구조 검사 인라인 평가 — 아래 "도출된 2중 방어") → ② v3.1 을 **독립 완결 문서**로
  전면 재작성(계층 개정 폐기, codex AC 표 채택, pending 수명 결정론 규칙, 예산 총량, 저장=conversationLog-only 결정) → ③ 패널 재실행 2×CLEAN

## ▶ 핸드오프 — 다른 머신에서 재개 절차 (2026-07-17)

1. **필수 읽기**: `AGENTS.md` → `.agents/context/process-status.json` → 이 파일 전체 → `.agents/reviews/issue-82-planning-v3-2026-07-17.json` → `.agents/reviews/issue-82-v3-evidence-hinge-2026-07-17.json`
2. **환경** (⚠️ 2026-07-17 후속 세션이 정정 — 근거는 아래 "환경 기술 결함" 절):
   - **모델 출처 = HuggingFace** (머신에 묶인 자산이 아니다):
     본체 `dnotitia/DNA3.0-9B` · GGUF `mradermacher/DNA3.0-9B-GGUF` 의 `DNA3.0-9B.Q4_K_M.gguf`.
     모델명의 `16k` = GGUF 속성이 아니라 **ollama Modelfile 의 `PARAMETER num_ctx 16384`**
     → 어느 머신에서든 `ollama create` 로 재구성 가능하다.
   - **기준 수치(B1 베이스라인·경첩 1차)가 나온 머신 = 윈도우 데모기**(RTX 4060 Laptop 8GB, ollama 0.31.1 —
     증적 = alpha-adk 루트의 `.agents/progress/dna3-local-llm-eval-2026-07-08.md`). 거기의
     `dnotitia-dna3.0-9b-q4-16k:latest` 는 **자가 변환 GGUF** 다. mradermacher Q4_K_M 은 **다른 빌드** =
     비트 동일 보장 없음. → 다른 머신에서 재구성하면 **기존 수치와 직접 비교 금지**.
     본 문서의 "모델 교체 시 벤치 전체 재실행(B1~B5)" 규칙이 그대로 적용된다.
   - `pnpm install && pnpm build` 선행(계측은 dist 정본 import).
   - ⚠️ **"로컬 Ollama" 라고 쓰지 말 것** — 이 문서는 크로스머신 재개 문서다. 호스트를 **이름으로** 적는다.
     (bazzite 개발기 참고: 시스템 `ollama.service` 는 읽기전용 OS 경로에 mkdir 실패로 재시작 루프 = 이 이슈와 무관한 별건 고장.)
3. **바로 할 일 = 위 "다음" ①**: `benchmark/v3-evidence-probe.mjs` 를 변형해 (a) 설명 강화판 (b) 구조적 교차 필드 검사(정규화 후 quote≡evidence equality → 확인질문 강등) 를 ②-only 3프로브(P-NEG-030/031/032) + positive 16프로브 회귀로 재측정. 목표: ②-only 즉시활성 0, positive evidence 채움율 84% 유지 이상.
4. **그 다음 v3.1 계약 재작성**: `docs/progress/99.dev-comm/UC-CONTINUE-SPEAKING-contract-2026-07-16.md` 의 계층 개정 구조 폐기, **독립 완결 신문서**로. 골격 = 패널 JSON 의 `codex_ac_rewrite_table` + 수렴 findings V3-1~7 의 action 전부 + 2차 실측으로 닫힌 ②-only 방어 규칙.
5. **불변 제약**: 헌장 파일 AI 단독 수정 금지 / app 은 의미 재판정 금지(키워드·정규식 금지) / 라디오 발화 = conversationLog 만, `memory.save` 금지(기억 오염 방지) / holdout(코퍼스 split=holdout) 튜닝 중 열람 금지 / 2회 연속 CLEAN 전 구현 착수 금지.
6. **주의**: `src/main/app/chat-turn-handler.ts` 의 현행 v1 구현(quote 가드)은 **기각 확정** — v3.1 채택 시 교체 대상. `CONTINUE_SPEAKING_TOOL` export 는 계측이 사용하므로 유지.

## ★★★ 2026-07-17 사용자 결정 — 이 절이 이전 전제를 덮어쓴다 (앵커)

인수 세션에서 사용자가 내린 결정. **아래 문서 본문 중 이와 충돌하는 서술은 전부 무효**이며, v3.1 계약 재작성 시 이 절이 기준이다.

| # | 결정 | 무효화되는 기존 서술 |
|---|---|---|
| **D1** | **미션 = 자유 발화 + 연속 발화.** "자유 발화"(self-initiated, 사용자 입력 없이 먼저 말 걸기)는 로드맵이 아니라 **이번 미션의 1급 대상**이다. | "범위 밖" 목록의 선제 발화 배제. 활동이 사용자 턴 안에 산다는 가정(턴 감금). |
| **D2** | **특정 모델에 의존하지 않는다.** `dnotitia-dna3.0-9b-q4-16k` 는 **데모용**(8G 데모박스 RTX 4060 Laptop 물리 한계에 맞춘 선택)이지 제품 기준 상수가 아니다. | "모델 교체 시 벤치 전체 재실행(B1~B5)" 이 **모델=상수** 를 전제로 한 규칙 → 폐기. 대신 **모델 패널 교차**가 기본. v1/v2/v3 판단의 근거 수치가 전부 데모 모델 1개 산이라는 점을 명시할 것. |
| **D3** | **로컬 머신 = 24GB 티어까지.** 코딩까지 감당하는 더 큰 모델을 상정한다. 8G 데모 모델은 하한 참조점일 뿐. | 8G 데모 모델의 습성(thinking ON 이어야 도구 호출, 오호출 17~50%)을 설계 제약으로 승격한 서술 전부. |
| **D4** | **GPU 배치 = GPU1 메인 LLM / GPU2 표현(TTS·아바타) + 서브 LLM.** | "단일 GPU 직렬 지형" 전제 → **무효**. 그로부터 도출된 "활동=저순위·선점 필연", "서브 LLM 상시 대화 불가(추론 2배)" 도 재검토 대상. 서브 LLM 은 물리적으로 다른 GPU 에서 **동시 실행 가능**. ⚠️ 단 분리 ≠ 무료 — RAM·swap·PCIe 는 공유(선례: 풀 cascade 2개 = GPU 분리해도 정체). "VRAM 경합 없음"이지 "자원 경합 없음"이 아니다. |
| **D5** | 라이브 데모 서비스 **중지 허용**(실측을 위해). | GPU 점유로 인한 실측 불가 사유 소멸. |

**미결 (별도 줄기 — 여기서 다루지 않는다)**: 노트북 티어의 **AMD NPU(XDNA) 활용**. 발상 = 데스크톱 2-GPU 분업과 동형으로
**NPU=메인 LLM / GPU=표현**. 지원 모델·스택(ollama 경로 아님)이 제한적이라 실측 필요. #82 완료 후 별건으로.

### 실측 머신 (bazzite 개발기) — GPU 배분과 복구 절차

RTX 3090 × 2 (각 24GB). **사용자 지시: GPU0 = 다른 세션 자유작업 몫 → 손대지 말 것. GPU1 = 이 작업 재량.**

| GPU | 평상시 점유 | 이 작업 |
|---|---|---|
| **0** | 아바타 Ditto TRT 렌더(:8902, 컨테이너 `ditto-trt-stream`) + chrome — 라이브 kiosk-v2 | ⛔ **무단 금지** |
| **1** | 컨테이너 `naia-omni` (VoxCPM2 7.7G + whisper large-v3 2.2G + llama-server ×2 8.0G ≒ 17.9G) | ✅ 재량 — 실측 위해 중지(사용자 승인) |

**`naia-omni` 중지/복구** — 컨테이너는 `--device nvidia.com/gpu=1` 로 GPU1 에 고정돼 있고, 호스트의 ollama 모델
디렉터리를 마운트한다 = **모델 스토어를 내 ollama 와 공유**(따로 받을 필요 없음):

- 중지: `podman stop naia-omni` — `restart=unless-stopped` 이라 명시적 stop 후 자동 복귀 없음. `autoremove=false` = 컨테이너 보존.
- 복구: `podman start naia-omni` (재생성 불필요).
- ⚠️ 중지 시 **동반 파손**: `naia-voxcpm2-bridge`(:22600→컨테이너) · `naia-cascade`(:8910) · `naia-cascade-event`(:8911) ·
  `kiosk-v3-tunnel`. 전부 이 컨테이너 의존 → 실측 종료 후 `podman start` 로 함께 복구. GPU0 의 kiosk-v2(:8902) 는 무영향.
- 내 ollama = 호스트 사용자 설치본(0.24.0) 를 직접 `serve`. **`CUDA_VISIBLE_DEVICES=1` 필수** — 미지정 시 GPU0 침범 위험.
- ⚠️ 별건 고장: 시스템 `ollama.service` 는 읽기전용 OS 경로에 mkdir 실패로 재시작 루프(28k회). 포트 미점유라 무해하나 정리 대상.

## ★★ 계약 누락 제약 — 메인 LLM 은 **도구 지원 계보**여야 한다 (2026-07-17 실측으로 문서화)

> ⚠️ **이것은 "발견"이 아니다.** 사용자는 이미 알고 있었고, **그래서 Qwen 계열을 썼다**(2026-07-17 사용자 확인).
> 데모 모델 `dnotitia-dna3.0-9b` 가 도구를 부를 수 있었던 이유도 그것 — **DNA3.0 = Qwen3.5 기반**
> (증적 = alpha-adk 루트의 `.agents/progress/dna3-local-llm-eval-2026-07-08.md` 사양 절).
> **문제는 이 제약이 계약·UC·FR 어디에도 적혀 있지 않다는 것이다.** 아는 것과 문서에 있는 것은 다르고,
> 안 적혀 있으면 다음 읽는 쪽이 추측한다 — 이 세션이 "로컬 Ollama"에서 당한 것과 동일 구조. 그래서 기록한다.

로컬 ollama 실측(raw `/api/chat` + tools 1개, 400 `does not support tools` 판정):

| 모델 | 크기 | 계보 | tools |
|---|---|:--:|:--:|
| `qwen3.6:27b` | 17.4G | Qwen (코딩) · **24G 티어** | ✅ |
| `gemma4:31b-it-q4_K_M` | 19.9G | Gemma · **24G 티어** | ✅ |
| `gemma4:e4b-it-q8_0` | 11.6G | Gemma 8B | ✅ |
| `huihui_ai/qwen3-abliterated:8b` | 5.0G | Qwen 8B | ✅ |
| `goekdenizguelmez/JOSIEFIED-Qwen3:8b` | 5.0G | Qwen 8B | ✅ |
| **`kanana2`** (카카오) | 18.6G | 한국어 · 24G 티어 | ⛔ |
| **`exaone45`** (LG) | 20.0G | 한국어 · 24G 티어 | ⛔ |
| **`HyperCLOVAX-SEED-Think-32B`** (네이버) | 22.8G | 한국어 · 24G 티어 | ⛔ |
| `kanana-judge` | 18.6G | 한국어 | ⛔ |
| `gemma-4-26B-A4B` (unsloth) | 15.4G | Gemma MoE | ⛔ |

**설계 함의 (v3.1 계약이 반드시 답해야 함)**: UC-015 의 활성화 판정은 **provider 의 도구 선택에 위임**돼 있다.
그런데 **국산 24G 티어 3종(kanana2·exaone45·HyperCLOVAX)이 전부 도구 미지원**이다 → 그 모델을 메인 LLM 으로
쓰면 **UC-015 는 아예 동작하지 않는다**(조용히). 계약은 이 경우를 규정한 적이 없다.
(ollama 템플릿에 tool 블록이 없다는 뜻이지 모델 자체의 능력 부재라는 뜻은 아니다 — 그러나 우리 배선에서는 결과가 같다.)

**★ 측정 함정 (패널 채점 시 필수)**: `ollama-provider.ts` §H.2 H-I3 은 400 `does not support tools` 를 받으면
**tools 를 빼고 1회 재시도**한다(순수 챗 graceful degrade). 그러면 `toolUse` 가 영영 안 나와 **`called:false` 로 흡수**되고,
채점표에서 그 모델은 **"오호출 0% = 완벽"** 으로 뒤집혀 보인다. → `v3-evidence-probe2.mjs` 는 raw 프리플라이트로
미지원 모델을 **패널에서 배제**하고 `excluded` 로 증적에 남긴다. codex T4-4 가 지적한 "provider 오류의 called:false 흡수"와 동일 계열.

## ⚠️ 환경 기술 결함 — 이 문서가 후속 세션을 드리프트시켰다 (2026-07-17 후속 세션 기록)

핸드오프를 인수한 세션(bazzite 개발기)이 **실측 대신 인프라 고고학에 시간을 썼다**. 원인은 이 문서다.

| # | 결함 | 결과 |
|---|---|---|
| 1 | 위 2항이 **"로컬 Ollama"** 라고 적었다 — "로컬"은 머신마다 뜻이 바뀌는 상대어인데, 이 문서의 존재 이유는 **크로스머신 재개**다. 자기모순. | 인수 세션이 localhost:11434 를 찔러 → 죽어 있음 → 서비스 로그 → 모델 스토어 → HDD 전수 검색까지 감. 호스트가 이름으로 적혀 있었으면 첫 curl 에서 멈췄다. |
| 2 | **모델 출처를 아무 데도 안 적었다.** 실제로는 HuggingFace 공개 자산(`dnotitia/DNA3.0-9B` + `mradermacher/DNA3.0-9B-GGUF`)이다. | 인수 세션이 "이 머신엔 없음 = 구할 수 없음"으로 오판. 사용자가 "허깅페이스에 있는 모델이야"라고 정정해 주고서야 풀림. |
| 3 | 유일하게 출처를 다룬 문서(alpha-adk `.agents/progress/dna3-local-llm-eval-2026-07-08.md`)가 **"공식 GGUF 없음 → 자가 변환 필요"** 라고 적었는데 **stale**. 2026-07-17 실측: 커뮤니티 GGUF 다수 존재(Q2_K~f16 + imatrix). | 결함 2 를 강화 — "그 머신에서 직접 만든 것"이라는 오판의 근거가 됨. |
| 4 | **"없으면 `TS_MODEL`/`TS_HOST` 로 대체"** 를 값싼 탈출구처럼 제시했다. 그러나 같은 문서가 "모델 교체 시 벤치 전체(B1~B5) 재실행 의무"를 못박는다. | 대체는 **측정 전체를 무효화**한다 = 값싸지 않다. 두 문장이 서로를 부정. |

**뿌리**: 계약 문서에 **정의되지 않은/상대적인 지시어**를 남기면 다음 읽는 쪽이 **추측으로 메우고**, 추측이 곧 드리프트다
(같은 계열 = "정의 없는 약어 추측"). **제거 = 이름으로 적기**: 호스트는 머신 이름, 자산은 출처 URI, 값은 절대값.

**본 문서에 적용한 제거**: 2항 전면 재작성(출처·기준 머신·quant 동일성 주의·"로컬" 금지). 결함 3 의 stale 문장은
alpha-adk 원문에서 정정. **재현 시 주의**: HF Q4_K_M ≠ 윈도우 자가변환 q4 → 재구성 시 베이스라인부터 다시 뜬다.

## ★ 경첩 실측 1차 (2026-07-17, v3 후보 스키마, 22프로브×6회, 증적 `.agents/reviews/issue-82-v3-evidence-hinge-2026-07-17.json`)

| 그룹 | call | evidence 채움 | 충실도(원문 부분문자열) |
|---|---|---|---|
| positive (①+②, 16프로브) | **96/96 = 100%** | 81/96 = 84% | 77/81 = 95% |
| **①-only** (3프로브) | 18/18 | **0/18 = 0%** ✅ | — |
| negative false-caller (8프로브) | 18/48 | **1/18** | 0/1 |
| **②-only** ("씻고 올게" 단독, 3프로브) | ⚠️ **11/18 = 61%** | 11/11 | 11/11 |

**성립한 것 (경첩 그 자체)**: 모델은 ② 신호가 없으면 옵셔널 `awayEvidence` 를 **한 번도 지어 채우지 않았다**
(①-only 0/18, 오호출 시 1/18 — 그 1건도 충실도 실패 = 메타 서술 "…신호가 없음"). 하이브리드의 핵심 규율 성립.
v3 규칙 하 negative 즉시-활성률: 원시 false-call 10% → **~2%**(evidence 게이트 통과분만).

**새 구멍 (실측이 계약 전에 잡음)**: `awayEvidence` 필드+설명의 존재가 **모델의 도구 선택 자체를 바꿨다** —
구 스키마에서 0/15 였던 ②-only("나 씻고 올게" 단독)가 신 스키마에서 **61% 호출**, evidence 충실 기입.
"잘 자" 에 "계속 얘기해줄까?" 확인질문이 뜨는 UX. **패턴 발견**: ②-only 위조 시 모델은 quote 와 evidence 에
**같은 텍스트**를 넣는다(P-NEG-030/032 전 샘플 quote==evidence, P-NEG-031 은 quote 빈 문자열).
진짜 ①+② 는 두 필드가 서로 다른 부분을 가리킨다.

**도출된 2중 방어 (둘 다 내용 무해석 — 키워드 금지 준수)**:
1. **구조 검사**: 즉시 활성화 = quote 비어있지 않음 ∧ evidence 비어있지 않음 ∧ evidence 가 사용자 원문의
   부분문자열(충실) ∧ **normalized(quote) ≠ normalized(evidence)**. 위반 시 확인질문 경로로 강등.
   (모델 자기보고 두 필드의 구조적 정합 — 의미 재추측 아님)
2. **설명 강화**: "계속 말해 달라는 요청 자체가 없으면(자리 비움 인사만으로는) 절대 호출 금지" 명시
   → ②-only 호출률 자체를 낮춤. 변수 하나씩: 2차 실측 = 설명 강화 + 전 콜 보존 + 후보 규칙 인라인 평가.
- session_id: 03b17f74-14d6-4390-a3ed-871d373001cf (2026-07-17 인수 세션 — 핸드오프 수령)
- prior_session_id: 08e07adf-cb54-4aab-81af-951410c386b7 (핸드오프 작성 세션, 윈도우 데모기)
- GitHub: https://github.com/nextain/naia-agent/issues/82
- 추적: REQ-013 → UC-015 → SPEC-012 → TEST-S-015 / TEST-F-012
- 경계: naia-agent app 계층. naia-shell·gRPC proto 변경 없음.

## 현재 단계

development/integration 적대 리뷰 2인 패널 실시 → **CLEAN 0회** (A=FINDINGS(7), B=FINDINGS(9)).
게이트("2회 연속 CLEAN") 미충족 → **커밋 금지**. 계약 §2 활성화 판정 규칙의 설계 결함이 확정되어
Issue #82 에 기록하고 결정을 받는다(= 설계 임의 수정 금지 규칙 적용).

## ★★ 확정 결함 — 활성화 가드가 작동하지 않는다 (A-HIGH1 = B-CRITICAL)

**실측**(리뷰어 B, 프로덕션 스키마 그대로, `dnotitia-dna3.0-9b-q4-16k:latest`, N=12):

| 사용자 입력 | 라디오 모드 활성화 |
|---|---|
| `오늘 날씨 어때?` | **4/12 (33%)** |
| `계속 이야기해 볼까? 넌 어떤 영화 좋아해?` | **6/12 (50%)** |

**메커니즘**: 활성화 시 모델이 넣는 `userRequestQuote` 는 **100% 사용자 원문 전체**다.
원문 전체는 자명하게 원문의 부분문자열이므로 `quoteMatchesUserText` 는 **항상 통과**한다.

**따라서 최소 길이/비율 하한으로 고쳐지지 않는다.** 원문 전체 인용은 어떤 길이 기준도 통과한다.
(A-HIGH1 이 제안한 "≥6자 또는 원문의 30%" 는 이 실측 앞에서 무효.)

**전제 자체의 오류**: 이 가드는 **출처**("모델이 지어냈는가")를 검사한다. 그러나 막아야 하는 실패는
**의도 오판**("사용자가 계속 말해달라고 했는가")이고, 실패 시 모델은 사용자의 *실제 말* 을 정확히 인용한다.
출처 검사는 의도 오판을 원리적으로 못 잡는다. 계약은 의도 판정을 provider 의 도구 선택에 위임했으나
그 도구 선택이 이 모델에서 평범한 질문에 33~50% 오작동하며, 가드는 그 뒤를 받치지 못한다.

**이전 기록 정정**: 2026-07-16 자 "보안속성 보존 확인" 표와 계약 §2 개정 노트의 "가드 목적은 그대로 유지된다" 는
**과장**이었다. 유지된 것은 "완전 날조 문장 거부" 뿐이고, 가드는 애초에 그 이상을 한 적이 없다.
개정 전 raw `includes` 에서도 동일하게 뚫려 있었다(= 정규화가 만든 구멍이 **아님**). 그러나 개정 노트가
가드에 실재하지 않는 방어력을 귀속시킨 것은 사실이며 철회한다.

## ★ AC9 "PASS" 판정 철회

`.agents/reviews/issue-82-ollama-integration-2026-07-16.json` 의 `verdict: PASS` 는 **긍정 방향만** 측정했다
(시연 문장 → 활성화되는가). 가드가 존재하는 이유인 **부정 방향**(평범한 질문 → 안 켜지는가)은 계약 테스트에도
통합 테스트에도 **0건**이었다. 이 상태의 PASS 선언은 definition_of_done 의 "AI 단독 Done 자가선언 금지" 위반.

부수 결함(증적 감사불가): 증적이 `activated: true` boolean 과 이벤트 종류 run-length 만 남기고
**모델이 실제 보낸 `userRequestQuote` 와 발화 텍스트를 0바이트** 기록한다. 그래서 "사용자 요청을 재현해 활성화"와
"원문을 통째로 복사해 substring 검사를 무의미하게 통과"를 리뷰어가 구분할 수 없었다. 실측 결과 후자다.

## ★ 계약 테스트가 경계를 고정하지 못한다 (B-HIGH ×2)

리뷰어 B 뮤테이션 테스트(스크래치패드 격리 하네스, 워크트리 무수정. kill-mutant `return false` → 8 fail 로 하네스 유효성 확인):

| 뮤턴트 | 스위트 |
|---|---|
| A: `includes(q)` → `includes(q.slice(0,1))` (첫 1글자만 대조) | **13/13 통과(생존)** |
| B: `pauseMs: pauseSeconds*1000` → `0` | **13/13 통과(생존)** |
| C: `deadlineAt: now()+durationMinutes*60_000` → `now()+60_000` | **13/13 통과(생존)** |
| G: `topic.slice(0,500)` → `slice(0,5)` | **13/13 통과(생존)** |
| E: 소비 후 control 재호출 terminalError 가드 삭제 | **13/13 통과(생존)** |
| F: 한 라운드 내 중복 control `index>0` 거부 삭제 | **13/13 통과(생존)** |

원인: AC12 가 `expect(activationLog?.ctx).toMatchObject(...)` 로 **로그에 적힌 숫자**만 단언하고
그 숫자가 **동작(대기시간·deadline)에 반영되는지**는 보지 않는다. 모든 `wait` 스텁이 `ms` 를 무시한다.
AC7/AC11 "일반 채팅 무회귀" 도 `scriptedProvider` 가 **도구를 부르지 않도록 스크립팅**되어 있어
정확히 그 실패 모드를 가정으로 배제한다 = vacuous.

## 그 외 findings (결정 불요 — 결함 확정 후 일괄 처리)

| # | 위치 | 요지 |
|---|---|---|
| A-HIGH2 | chat-turn-handler.ts:323,327 | `controlConsumed` 를 quote 검사 **전** 설정 + 2회차 control = `terminalError` → 거부된 모델이 재시도하면 턴 사망·저장 0회. AC13 "거부해도 일반 응답 끝까지 처리" 위반. 정합 처리 = 조용한 거부 thread. (트리거는 스키마 밖 도구명 재방출 필요 = 가능하나 미확증) |
| A-MED | :68-71,336 | 계약 §7 은 "**단조** 시각" 명시인데 기본 clock = `Date.now()`(비단조). NTP step 시 시간축 경계 소실. `performance.now()` 로 교체하거나 계약에서 "단조" 철회 |
| A-MED | :244-245 | `disabledSkills` 로 control 을 끌 수 없음(무조건 prepend). 유일한 off = `enableTools=false`(전체 도구 차단) |
| A-MED | :347-350 | `MAX_TOOL_ROUNDS=8` 을 60발화 세션이 공유 → 라디오 중 9번째 도구 라운드가 턴 사망 + 방출 완료된 수십 발화 저장 0회. §5/AC6 충돌, 계약 미규정 |
| A-LOW | :327 vs §8 | 재노출 금지 조건이 계약은 "활성화 후", 구현은 "거부 후"도 잠금 = 문구 불일치(A-HIGH2 수정 시 순수 문구 문제로 축소) |
| A-LOW | :244,358 | 외부 executor 가 동명 도구 등록 시 조용히 하이재킹(진단 로그 0건) |
| B-HIGH | integration test:34,90-100,204 | "모델이 스스로 이어간다" 미증명 — 발화 #2 는 **앱이 주입한** `[CONTINUE_SPEAKING]` 지시에 대한 응답. 모델 자율 결정은 round 0 tool call 1회뿐. 텍스트 내용 단언 0건 → 발화 #2 가 "더는 말 못해요" 여도 통과 |
| B-HIGH | integration test:92-100 | 가상 시계가 `finish=1/error=0` 을 만든다(자기 하네스 검증). 실 `Date.now`·10분 deadline·3초 pause·60발화 누적 경로 미측정 |
| B-MED | integration test:27,194 | 기본 `pnpm test` 는 게이트 env 없어 전체 skip + exit 0. 강제하는 CI 없음. 증적 JSON 은 테스트 자신이 쓰고 커밋 → 회귀해도 과거 PASS 파일이 남아 통과처럼 보임 = 명예 시스템 |
| B-LOW | contract test:230,263 | (a) AC12 가 `includes("연속 발화 활성화")` → 거부 로그 `"연속 발화 활성화 거부"` 와 접두사 충돌(현재는 우연히 fail). 통합테스트는 `===` = 두 파일 판정 규칙 불일치. (b) `accept-${quote.length}` 라벨 5개 충돌 |

## ★★ 승인 게이트 재설계 — planning 패널 2/2 기각 (2026-07-17)

사용자 승인(2026-07-17)으로 "사용자 확인 게이트" 방향을 잡고 계약 §2 를 재설계(= `continue_speaking` 을
gated tool 로 만들어 기존 `ApprovalPort` 재사용) → planning 적대 패널 결과 **A=FINDINGS(8), B=FINDINGS(10),
CLEAN 0회** → **기각**. AI(나)의 권고가 틀렸다. 기각 사유(전부 코드/실측 확인):

| # | 사유 | 근거 |
|---|---|---|
| 1 | **음성 데드락** | 모달=클릭 전용(`PermissionModal.tsx:25-67`), TTS 미노출(`ChatArea.tsx:1230-1242` 는 `case "text"` 만). STT "네" → `handleSend` → `isChatRequestActive()` → `enqueueMessage` 처박힘(`ChatArea.tsx:895-899`). **턴은 승인 대기 · 승인은 턴 종료 후 전달 = 상호 봉쇄.** 승인 timeout 부재(`approval.ts:22-61` 타이머 0, 셸 120s 캡은 new-core 경로 도달불가) → 무기한 |
| 2 | **자기모순** | UC-015 는 **사용자 부재**("난 씻고 올게")가 전제인 유일한 기능. 거기에 **사용자 현존**을 요구하는 게이트를 다는 설계 |
| 3 | **"항상 허용" 원클릭 자폭** | `addAllowedTool` → `config.allowedTools` 영속 → `isToolAllowed` 가 모달 없이 자동 승인. quote 가드는 이미 삭제 → **재설계 전보다 나쁨**. 팝업 피로가 그 버튼을 누르게 하는 **자기파괴 루프**. A·B 독립 확인. (naia-shell `F1-baseline-contract` 가 이미 "영구 grant 우회"로 자체 표기, D40 Phase5 제거 예정) |
| 4 | **AC14 가 이 구멍을 못 잡음** | AC14/AC9-neg 는 fake ApprovalPort 로 **app 경계**에서만 측정 → 위 경로는 app 에 정상 `approve` 로 도착 → **AC14 PASS + 프로덕션 CRITICAL 생존**. 2026-07-16 과 동일한 실수(측정 경계가 결함을 배제)를 새 계약에 재삽입 |
| 5 | **오호출률 미저감** | AC1~AC14 중 팝업률을 한정하는 AC **0개** → "17~50% 확률로 모달이 뜨는 제품"이 전 AC 통과. 문제를 UX 로 이동만 |
| 6 | 계약 자기위반 | UC `S-CONT-5`("미활성 시 UC1/UC5 동작 불변") 모순(오호출 턴은 reject 해도 wire 이벤트 추가 + provider 2회). 계약 7행("셸 무변경")·176행("셸 라디오 UI=범위 밖") 위반 |
| 7 | **AC13 산술적 불가능** | "reject → provider 호출 1회 유지" ← 도구 라운드는 반드시 재호출(`chat-turn-handler.ts:408`) → 최소 2회 |
| 8 | 승인 페이로드 공백 | `:373` description 을 `externalTools` 에서 찾는데 control 은 `:244` 에서 제외됨 → `description: ""` → 사용자는 **제목 없는 모달 + 원시 JSON** 보고 승인 |

## ★★ 근거 수치 자체가 부실했다 (2026-07-17)

리뷰어 B 가 **같은 스크립트·모델·스키마**로 재측정: 계약 기록 `4/12 (33%)` → 재현 **`2/12 (17%)`**.
N=12 의 95% CI ≈ [10%,65%] vs [2%,48%] = **구별 불가**. **아키텍처 결정 전체가 ±25pp 오차의 숫자 위에 서 있었다.**
AC9 의 N=2 는 그보다 훨씬 나쁘다. → **프로브 코퍼스(N≥100, 홀드아웃 분리)가 없다.** 이게 선행 과제.

## ★★ 오호출률은 프롬프트의 함수다 — 선택지 4 의 선험적 기각이 틀렸다

리뷰어 B 실측(프로덕션 스키마+body, `dnotitia-dna3.0-9b-q4-16k:latest`, stream=false, think=on, **N=12/셀, 72콜**):

| 프로브 | 현행 설명 | 개선 설명 |
|---|---|---|
| `계속 이야기해 볼까? 넌 어떤 영화 좋아해?` | 6/12 (50%) | **0/12 (0%)** |
| `오늘 날씨 어때?` | 2/12 (17%) | 2/12 (17%) — 무변화 |
| 시연 문장(양성) | 12/12 (100%) | 11/12 (92%) — **회귀** |

→ 어휘 혼동성 오호출은 **설명이 원인**(50%→0%). 도구 남용 성향은 설명으로 안 잡힘(17% 고정).
양성 92% = AC9-pos 2연속 요구가 ~16% 확률로 깨짐 = 거짓 음성 대가. **단독 불충분하나 "먼저 할 일"은 실재.**
2026-07-16 에 내가 선택지 4 를 "근본 해결 아님·단독 채택 불가"로 *선험적으로* 기각한 것은 근거 없는 판단이었다.

**신규 선택지 5b — 앱계층 모델 검증자**(B 실측): control 호출 후 앱이 사용자 최신 발화만으로 격리 YES/NO 분류
1콜(temp=0, think=false). 음성 **0/48**, 양성 18/24. §2 "키워드 정규식 금지" 불위반(의미 판정은 여전히 모델 몫),
계약 경계(app 계층, 셸·proto 무변경) 준수, 모달 없음, **음성 전용에서 동작**.
⚠️ **미완**: 홀드아웃 양성 `나 청소하는 동안 멈추지 말고 계속 얘기해줘` **0/6 거부**(거짓 음성) — 채택 불가 상태.

**신규 제약(5c opt-out 검토 시 필수)**: TTS 재생 중 마이크 off(`ChatArea.tsx:1814`) → S-CONT-3 의 "사용자가 말하거나"는
**발화 중엔 동작하지 않고 발화 간 3초 간극에서만** 가능. 즉시 정지 보장 설계는 이 제약을 먼저 풀어야 한다.

## ★ 벤치마크 스위트 명세 (2026-07-17 사용자 지시: "제품 기능이므로 벤치마크도 명확히 있어야 한다")

일회성 진단이 아니라 **상시 회귀 게이트**로 설계한다. 특히 **모델 교체 시 전체 재실행이 의무**
(시연 모델 dnotitia 의 thinking 의존성·17~50% 오호출은 모델 고유 특성 — 교체하면 수치가 통째로 바뀐다).
위치 = `benchmark/` (F12 등록 완료 디렉터리, "성능·정확도·자율성 벤치마크"), 선례 = UC-HLMEM 벤치 계약.

| # | 벤치 | 무엇을 재나 | 지표 | 코퍼스/방법 | 상태 |
|---|---|---|---|---|---|
| B1 | **진입 판정** (activation) | 모델이 활동 진입을 올바르게 판정하나 | false-call rate / miss rate (+Wilson CI) | `corpora/continue-speaking-ko.corpus.json` 89건, dev/holdout, runs≥5 | ✅ 러너 완성, 베이스라인 측정 중 |
| B2 | **확인질문 경로** (clarify) | 애매 발화에서 진입/무시가 아니라 **물어보나** | clarify rate on ambiguous / false-clarify on clear-pos·neg | ambiguous 버킷 10건(확장 필요) + 판정 = 응답이 질문인가(모델 채점 또는 구조 판정) | ⬜ 설계 대상 — 확인질문 설계 채택 시 B1 과 동급 필수 |
| B3 | **정지 준수** (stop) | 활동 중 "그만" 류를 알아듣고 멈추나 | stop-recognition rate / 오정지율(일반 대화 발화를 정지로 오인) | 정지 코퍼스 신설(정지 발화 vs 활동 중 일반 끼어들기 발화) — **허용 오호출률을 정하는 변수**: 정지가 쌀수록 진입 오판에 관대해질 수 있다 | ⬜ 신설 필요 |
| B4 | **장기 발화 품질** (long-run) | 60발화 동안 반복·열화·주제이탈이 없나 | n-gram 반복률 / 발화간 유사도(embedding) / 길이 드리프트 | 실연동 장시간 러닝(리뷰어 B 지적: 현 통합테스트는 발화 2개로 끝 — 반복·열화 미측정) | ⬜ 신설 필요 |
| B5 | **경계 준수** (bounds) | deadline·60발화·취소 등 유한 경계 | 결정론 계약테스트 + 실시간 통합테스트 | 벤치 아님 — 테스트 게이트(단 **행위 단언**으로, 뮤턴트 생존 이력 있음) | ⬜ 재작성 대상 |

원칙(자가개선 철학 정합):
- **holdout 규율**: 튜닝 중 holdout 열람 금지(러너가 `TS_HOLDOUT_ACK=1` 강제) — 벤치 과적합 배제.
- **프로덕션 실물 측정**: 스펙·provider 를 dist 에서 import(복사본 금지) — 드리프트 = 거짓 수치.
- **CI 필수 표기**: 코퍼스 단위 지표에 Wilson 95% CI 동반 — CI 없는 단일 수치로 의사결정 금지(이번 사고의 교훈).
- **게이트 임계값은 P01 확정 후**: 허용 false-call 은 되돌리기 비용(B3 결과)의 함수 — 독립적으로 정할 수 없다.

## ★ B1 베이스라인 실측 (2026-07-17, dev 54프로브×5회=270콜, 현행 도구 설명, 증적 `issue-82-tool-selection-baseline-dev.json`)

| 지표 | 값 | 95% CI |
|---|---|---|
| false-call (negative n=160) | **10.0%** | [6.2%, 15.6%] |
| miss (positive n=80) | **5.0%** | [2.0%, 12.2%] |
| ambiguous call-rate (n=30, 지표 제외) | 60.0% | [42.3%, 75.4%] |

**관측 1 — 이전 수치들의 정체**: "오늘 날씨 어때?" 는 이번 1/5(20%). 역대 측정 33%(4/12) → 17%(2/12) → 20%(1/5)
= 전부 참값 ~15-25% 대역의 소표본 요동. 코퍼스 풀링 10% 가 설계용 수치다.

**관측 2 — 오호출의 구조** (byCategory):
- **부재만**("나 씻고 올게" 단독): **0/15 = 0%** — 모델은 ②만으로는 절대 안 켠다
- 일반질문 5% · 짧은발화 10% · **어휘함정 16% · 도구요청 20%**
- ⚠️ **정지 카테고리에서 1건**: "조용히 해줘" → 활성화 1/5 — **정지 요청에 라디오를 켜는 최악 유형** 실재

**관측 3 — 모델의 암묵 경계 = ① 단독** (가장 중요):
- ambiguous 중 ①충족·②부재 3건("아무 얘기나 계속 해줘"·"심심한데 얘기 좀 계속 해줄래?"·"잠들 때까지 얘기해줘")
  = **각 5/5, 100% 활성화**
- ambiguous 중 직전답변-이어가기 3건("계속해"·"그래서? 계속 말해봐"·"아까 하던 얘기 계속하자") = 1/5·2/5·0/5
- 즉 모델은 "끝을 정하지 않은 연속 요청(①)이면 켠다, ② 는 안 본다"로 일관 동작 중.
  **P01 라벨 결정(① 단독 vs ①+②)에 따라 이 3건×100% 가 정상이 되거나 false-call 이 된다** — T4-1 순환정의
  지적이 데이터로 구체화된 것. 결정 없이는 desc-b A/B 튜닝도 진행 불가(승인 안 된 기준으로 튜닝하는 셈).

## 결정 필요 — 다음 순서

리뷰어 B 권고(내가 동의하는 순서):
1. **프로브 코퍼스 구축**(N≥100, 홀드아웃 분리) — 지금 없다. 모든 판단의 계측 기반.
2. **도구 설명 최적화**(실측 50%→0% 확인) + **양성 회귀 감시**(100%→92% 대가).
3. 잔여 오호출에 **앱계층 검증자(5b)** 튜닝(음성 0/48 유망, 홀드아웃 양성 실패 해결 필요).
4. 그래도 남는 것은 **opt-out(5c)** 로 흡수 — 단 TTS 중 마이크 off 제약 선결.
5. 승인 게이트를 굳이 쓴다면 "항상 허용" 차단 + TTS 고지 + timeout 이 **선행 조건**이며 전부 **셸 변경** =
   계약 경계(7행·176행) 재협상 사안.

## ★★ 범주 재점검 (2026-07-17, 사용자 문제제기: "기능/모드/loop/장기작업 중 뭐냐" + "너무 얇게 접근한 것 아니냐" + "인간사상 부합하냐")

### A. "너무 얇게" — 실증 확인됨

naia-agent 에는 "시간이 걸리는 자율 활동"의 형상이 이미 **3개 따로** 존재한다:

| 형상 | 모델 | 상태 |
|---|---|---|
| UC-014 supervisor/sub-agent (pi·opencode spawn) | **작업(task)**: spawn → 감독 → 정직보고 1회 | Done (계약·테스트 완비) |
| cron-skills | **예약**: schedule/list/cancel | ⚠️ **껍데기** — `CronStorePort` 구현체 0건, composition 주입 0건 → 모델에 도구로 노출되지만 영구 "unsupported" |
| UC-015 라디오 | **턴 내 루프** | 이번에 무너진 것 |

공통 범주("자율 활동")가 정의돼 있지 않고, 라디오는 그중 **가장 얇은 형상(턴)에 욱여넣어졌다**.
이번 세션의 버그가 전부 이 불일치에서 나왔다: 승인 데드락(승인=턴 스코프, 사용자=부재),
끝에 한 번 저장(9분째 에러 = 전량 유실), `MAX_TOOL_ROUNDS=8` 공유(턴 개념이 30분 세션을 죽임),
"범위 밖" 목록(재시작 재개·세션 지속 = 모드라면 당연한 것들을 범위 밖으로 밀어냄 = 정체 부정).

### B. 인간사상("인간과 같이 생각하게 설계") 정합 — 턴 모델은 부합하지 않는다

naia 의 사상(UC-HLMEM memory-as-user-model, 장기기억+진짜 기억) 기준으로 인간의 라디오 행동:

| 인간 | 현 구현 |
|---|---|
| 문장 분류가 아니라 **상황 이해**로 판단, **애매하면 물어본다** | quote 가드(기각)·승인 모달(기각) = 둘 다 비인간적 장치 |
| 활동 중임을 **자각**한다 ("나 지금 얘기 중") | 턴 지역변수 — 자기 상태 없음 |
| 상대가 돌아오면 **알아차린다** (지각 루프) | TTS 재생 중 마이크 off — 지각 차단 |
| 자기가 한 말을 **기억**한다 | provider-local 직전 발화 1개만 유지 |
| 끊기면 **재개**한다 ("어디까지 했더라") | "범위 밖"으로 배제 |

**핵심 도출 — 애매 버킷의 인간적 해법 = 인바운드 확인 질문.** "계속 얘기해줄까? 씻으러 가는 거야?" 를
**대화 안에서** 묻는 것: UI 0 · 셸 변경 0 · app 계층 자연 구현 · naia "유저 권한 이양 1급" 정합.
corpus 의 ambiguous 10건이 정확히 이 경로의 대상이다. 확신 케이스(P-POS 류)는 즉시 진입(무마찰 보존),
애매 케이스만 물어본다 — 인간이 정확히 이렇게 한다.

### C. 범위 판단 (2026-07-17 사용자 정정 반영: "시연 기능 때문이 아니야. 진짜 하려는거야")

~~시연 기능 1개를 위한 프레임워크 선설계 = 과적합~~ ← **전제 오류였다.** 연속 발화는 시연 원오프가 아니라
**제품 방향**이다(사용자 확인). 그러면 "두 번째 소비자가 생길 때 통합" 유예는 성립하지 않는다 —
**소비자가 이미 셋 실재**하기 때문:

1. **대화 활동**: 라디오/연속 발화 (이번 것 — 첫 번째 대화형 활동)
2. **예약 활동**: 내부 cron (사용자가 필요하다고 명시. 현재 `CronStorePort` 껍데기 = 이 프리미티브가 없어서 못 만든 것)
3. **작업 활동**: UC-014 supervisor/pi sub-agent (이미 Done — 단 자기만의 형상으로)
4. **인지 활동**: naia-memory **꿈 기능**(Background brain: replay+spike+priority = CLS+SWR+DMN,
   `naia-memory/docs/cognitive-architecture.md`) — 유휴 시 기억 응고 + **spike → 활성 대화 주입**.
   라디오와 정확히 **쌍대**(사용자 부재 중 자기지속 활동, 소리 유/무만 차이). 꿈이 요구하는
   유휴 트리거(=cron backend)와 활동→대화 주입 채널이 이 프리미티브 없이는 불가.

**공통/분리 설계 (2026-07-17, 사용자 질문 "어떤 건 공통이고 어떤 건 나누나 + 서브LLM↔메인LLM 구현?")**:

- **공통 = 활동 섀시(수명 관리)**: 시작 계기 · 보이는 상태 · 정지 1급 · 유한 경계 · 중단/재개 ·
  지각 결합(활동 중에도 사용자 신호에 양보, 대화 봉쇄 금지) · 증분 저장 · 자원 스케줄링(단일 GPU
  직렬 지형에서 활동 = 저순위·선점 가능 — 이 스케줄러가 곧 cron backend) · 관측/벤치 훅.
- **분리 = 근간이 다른 3축**:
  ① **생성 주체**: 라디오=메인 LLM / 꿈=서브 로컬 LLM / cron=없음 / supervisor=외부 에이전트.
  ② **기억 쓰기 권한(인지 무결성 경계)**: 꿈=기억 변조가 존재 이유 / **라디오=대화로그 이상 금지**
     (지어낸 이야기가 장기기억에 응고되면 기억 오염 = "진짜 기억" 원칙 위반) / supervisor=워크스페이스만 / cron=없음.
     섀시 공통값 금지 — 활동별 명시 부여.
  ③ **프라이버시 티어**: 꿈=로컬 강제("기억 추론 로컬, 외주화 금지") / 라디오=대화 provider 그대로.
- **표면화 불변식**: 사용자를 향하는 모든 발화는 메인 LLM(페르소나) 통과 = "유일한 입".
  배경 활동은 재료 생산, 메인이 귀속·공연(source monitoring 정합).
- **서브↔메인 결합 = 대화가 아니라 큐**: 상시 대화는 단일 GPU 에서 추론 2배 + 메인이 배경에 묶임(저순위
  원칙 충돌). 서브는 혼자 돌고 산출을 spike 큐에 → 메인이 자기 턴에 표면화 여부 판단(단방향 + 게이팅).
- **라디오의 서브 LLM 감독은 B4 조건부**: 라디오 실패는 생성 품질이 아니라 진입 판정이었다.
  B4(60발화 반복·열화)가 열화를 실증하면 pause 3초 동안 도는 경량 감독(다음 방향만 계획)이 처방.

**분류학 (2026-07-17, 사용자 질문 "표면적인 CoT로 봐야 할까"에 대한 판정)**:
상위 범주 = **자기지속 인지 활동**(사용자 입력 없이 모델이 생성을 스스로 잇는 것). 그 아래
thinking(숨은 과제지향 CoT) / 라디오(소리 내는 독백) / 꿈(기억 위 오프라인 재생) 이 형제다 —
인간의 내적 언어/발화/꿈과 동형(인간사상 정합). **단, 개념 분류이지 구현 지시가 아니다**:
라디오를 thinking 채널로 구현하면 안 된다 — ① 품질 규범 반대(CoT=탐색적·자기수정 vs TTS 발화=다듬어진 짧은 문장),
② 수명 다름(thinking=비저장 vs 발화=기억 대상, 계약 §5), ③ 실측상 층이 다름(이 모델은 thinking ON 이어야
도구를 부름 = CoT 층은 발화 아래서 이미 따로 돈다).

수정된 권고 — **활동(activity)을 1급 아키텍처 개념으로 지금 설계한다**:
- **P01 수준의 재설계**: "활동" = 시작 계기(**사용자 요청 / 예약 / 위임 / 자기 시작(spike·유휴)** —
  2026-07-17 사용자 사상 선언 "자발적 발화가 가능한 게 내 설계 사상": self-initiated 는 로드맵이 아니라
  1급 계기 분류. 활동 계약이 "활동은 사용자 턴 안에서 산다"를 가정하면 그 순간 자발 발화가 막힌다 —
  턴 감금 실수를 한 단계 위에서 반복하는 것) · 보이는 상태 · 정지 1급 · 수명 경계 ·
  저장 정책(진행 중 증분) · 중단/재개 · 지각(활동 중에도 사용자 신호 수신) 을 가진 런타임 개념.
  라디오는 그 **첫 대화형 소비자**, cron backend 는 **예약 소비자**, supervisor 는 **기존 작업 소비자**로 정렬.
- **구현은 여전히 슬라이스로**: 개념 설계는 전체, 구현은 라디오부터. 계약-우선(IDD)은 불변.
- "범위 밖"이던 항목들(재시작 재개·선제 발화·세션 지속)의 지위 재평가 필요 — 제품 방향이면
  이것들은 배제가 아니라 **로드맵**일 수 있다 = P01 에서 사용자와 확정.
- **계측은 범주와 무관하게 유효**: 진입 판정은 여전히 모델이 하므로 corpus·러너·오호출률은 그대로 필요.
  달라지는 것은 **허용 오호출률**(되돌리기 비용이 싸질수록 관대해짐)과 ambiguous 버킷의 지위(제외 → 확인질문 대상).

⚠️ 진행 중인 codex 크로스리뷰(T2)는 정정 **전** 명제("통합은 두 번째 소비자 때")로 걸려 있다 —
결과 해석 시 이 전제 변경을 반영할 것.

### D. 크로스리뷰 결과 (codex gpt-5.6-sol, 2026-07-17) — FINDINGS(6)

증적: `.agents/reviews/issue-82-recategorization-codex-2026-07-17.json`. 핵심 판정:

- **T1 부분 반증 → 명제 정제**: "도구 호출은 활동의 **시작 명령**으로 유지 가능. 버릴 것은 도구 호출이
  아니라 **활동 수명을 턴 지역변수에 가두는 것**." 또한 quote 가드 실패는 범주와 무관한 의도 분류
  실패(전 결함의 단일 원인화 기각). → 채택.
- **T2 반증 성공**: "두 번째 소비자 때 통합" 유예는 이미 조건 충족(supervisor=실소비자 2호). 사용자
  정정과 **독립적으로 동일 결론** = 수렴 검증. 단 공통 확정 대상 = 활동의 상태·정지·수명·체크포인트·재개
  **계약**이고 구현은 radio 슬라이스부터(단계적 구현 유지). → 채택.
- **T3 조건부 성립 — 구체 설계 확보**: "모델이 알아서 물어본다" ✗ → **"app 이 확인 상태기계를 강제"** ✓:
  `positive→즉시 / ambiguous→pending_confirmation(sessionId, activityType, expiresAt) / negative→일반`.
  '응' 판정은 pending 상태에서만, ambiguous 에서 모델이 확인 없이 도구 호출하면 활성화 불인정.
  P01 에 TTL·세션 결속·취소 규칙 필수. (sessionId 는 이미 존재 = 결속 가능 확인됨)
- **T4 반증 성공 — 계측 기반 4건 수정**:
  1. **라벨 순환정의**: 코퍼스 조건 ②(부재/수동청취)의 근거가 구현의 도구 설명 = 권위 역전.
     **P01 이 ② 를 승인해야 라벨이 정당화됨** → P01 결정 항목.
  2. ambiguous "제외" ↔ T3 비양립 — T3 채택 시 정답은 "확인 질문" = 러너 3분류(direct/ask/reject) 필요 → TODO.
  3. holdout 잠금이 `TS_SPLIT=all` 로 우회됨 → ✅ 즉시 수정(all 도 ACK 요구).
  4. 통계: 프로브 군집효과로 풀링 CI 과소폭 + provider 오류의 called:false 흡수 = 비대칭 오염
     (유효 독립 문장 dev neg 32·pos 16) → ✅ 부분 수정(오류 별도 집계 + probeMeanRate 병행 + caveat 명기),
     프로브 계층 bootstrap/베타-이항은 후속.

## P01~P03 게이트 무효화 (신규)

`.agents/context/process-status.json` 이 P01·P02·P03 를 `"done"` 으로 두고 있으나:
- `docs/user-scenarios.md:272-274` UC-015 본문이 "요청**하면** … **즉시** 재생" 으로 승인 없는 인과사슬을 못박음
- `docs/user-scenarios.md:286-289` S-CONT-5 "미활성 시 동작 불변" 이 오호출 턴과 모순
- `docs/requirements.md:223` FR-CONT-1 이 **폐기된 quote 가드**를 활성화 판정으로 규정

→ 활성화 설계 확정 후 **P01·P02·P03 재개정 필요**. process-status.json 은 헌장 파일 = 사용자 승인 대상.

## 기존 변경 보존

`src/main/adapters/ollama-provider.ts` 의 기존 시연 안정화 동작(DEFAULT_NUM_CTX 16384)은 Issue #82 범위가 아니며 바꾸지 않는다.
