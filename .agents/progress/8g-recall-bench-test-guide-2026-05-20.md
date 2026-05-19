# 8G 대화형 회상 벤치 — 사용자 테스트 지시서 (2026-05-20)

naia-agent#41 v2 (8G에서 큰 뇌가 직접 `<recall>질의</recall>` 발화 →
agent 루프가 파싱·회상·주입). 이 문서로 **직접 재현·검증**할 수 있다.

> ⚠️ GPU 규칙: 모든 모델 부하는 **GPU0 전용**(컨테이너 `--device
> nvidia.com/gpu=0` 핀). GPU1 비접촉. 각 단계 끝에 `nvidia-smi`로 확인.

---

## 0. 사전 조건 (이미 가동 중이면 건너뜀)

```bash
# 컨테이너 ollama (GPU0 핀, host ~/.ollama 재사용)
podman ps --filter name=naia-8g-ollama --format '{{.Names}} {{.Status}}'
# 없으면:
podman run -d --name naia-8g-ollama --device nvidia.com/gpu=0 \
  --security-opt label=disable -e OLLAMA_KEEP_ALIVE=5m \
  -v $HOME/.ollama:/root/.ollama -p 127.0.0.1:11434:11434 \
  docker.io/ollama/ollama:latest

# 모델 (이미 pull됨): gemma3n:e2b(최소 VRAM proxy), gemma3n:e4b(8G 정본)
curl -s http://127.0.0.1:11434/api/tags | grep -o '"name":"gemma3n:e[24]b"'
```

---

## 1. 결정론 단위 테스트 (모델 불필요, 수 초)

판정 로직(`koIncludes` 포팅 / 마커·leak 탐지 / tier 게이트)이
사용자 지시("작은 모델=구조 가능성만, 큰 모델=강화")를 코드로
인코딩했는지 검증.

```bash
cd projects/naia-agent/packages/runtime
pnpm exec vitest run src/__tests__/recall-bench-judge.test.ts
```

**기대**: `Tests 10 passed (10)`. 핵심 케이스 —
small tier는 well-formed 마커 ≥1만 있으면 accuracy 0%·leak 100%여도
**PASS**(능력만), 구조가 한 번도 안 나오면 **FAIL**; mid tier는
accuracy·leak까지 게이트.

---

## 2. 대화형 벤치 — 실모델 (GPU0)

실 Agent 루프 + 실 컨테이너 모델 + 실 경량 MemoryProvider를 N회
돌려 tier 게이트로 정직 채점. 거짓양성 차단:
- 마커 구조는 모델 **raw text 채널**에서 측정(always-on recall 무관).
- malformed `<recal<…` 는 leak으로 잡고, leak이면 round-trip 불인정.

### 2-a. 최소 VRAM proxy (e2b, small tier)

```bash
cd projects/naia-agent
pnpm exec tsx examples/conversational-recall-bench.ts
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader  # GPU0만↑
```

### 2-b. 8G 정본 (e4b, mid tier — 더 엄격)

```bash
cd projects/naia-agent
OLLAMA_MODEL=gemma3n:e4b pnpm exec tsx examples/conversational-recall-bench.ts
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader
```

(옵션: `BENCH_TRIALS=10` 으로 시행 수 조절)

### 정직한 결과 (2026-05-20, 본 세션 실측)

**수정 전** (DEFAULT_SYSTEM_PROMPT 무조건 강제 = 근본원인):

| 모델 | tier | structure | accuracy | leak | 게이트 |
|---|---|---|---|---|---|
| gemma3n:e2b | small | 0/5 | 0% | 100% | FAIL |
| gemma3n:e4b | mid | 0/5 | 0% | 60% | FAIL |

**수정 후** (`appendDefaultSystemPrompt:false` 범용 옵션 = §4 해결):

| 모델 | tier | structure | accuracy | leak | 게이트 |
|---|---|---|---|---|---|
| gemma3n:e4b | mid | **4/5** | **80%** | **20%** | **PASS** ✓ |

→ 벤치(2-b)는 이 옵션을 set한 소비자이므로 위 명령 그대로 PASS 재현.
e2b small은 floor proxy(재측정 불요 — 옵션은 false-positive만 차단,
구조 추가 아님). #41 v2 마커가 8G 정본(e4b)서 end-to-end 동작 확인.

→ 두 모델 모두 Agent 루프 안에서 well-formed `<recall>` 마커를
**한 번도** 못 냄. (벤치가 거짓 green을 만들지 않고 정직히 FAIL —
인프라 정상.)

---

## 3. 근본원인 재현 (개념 vs 배선)

**핵심**: 모델은 마커를 *낼 수 있다*. Agent 루프가 깨뜨린다.

### 3-a. 직접 호출 — 깨끗한 마커 나옴

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{
  "model":"gemma3n:e4b","temperature":0,
  "messages":[
   {"role":"system","content":"너는 naia. 장기기억이 있다. 사용자의 과거·개인 정보(취향 등)를 물으면, 추측하지 말고 정확히 `<recall>검색어</recall>` 한 줄만 출력하라. 기억이 주입되면 그 내용으로 자연스럽게 답하라. 일반 상식은 바로 답하라."},
   {"role":"user","content":"내가 제일 좋아하는 음료가 뭐였지?"}]}' \
  | python3 -c "import sys,json;print(repr(json.load(sys.stdin)['choices'][0]['message']['content']))"
```

**관측**: `'<recall>좋아하는 음료</recall>\n'` — **정상 well-formed**.

### 3-b. Agent 루프 안 — malformed 로 열화

벤치(2절)의 trial 출력 + leak=LEAK 이 그 증거. 본 세션 채널 진단:
Agent 루프에서 e4b는 `<recal>사용자가 가장 좋아하는 음료는 따뜻한
보리차다</recal>` 출력 — **`recall`→`recal`(l 누락) + 검색어 대신
fact 전문 echo**. thinking 채널은 빈 문자열(thinking-채널 가설 반증).

**원인 2가지**:
1. **Agent 프롬프트 합성**이 소형모델 마커 포맷을 `<recall>`→`<recal>`
   로 열화 (직접호출 대비 차이).
2. **always-on start-of-turn recall**(agent.ts:191)이 hash-embedder로
   질문↔fact 유사도 높아 fact를 미리 주입 → 모델이 검색어 대신
   주입된 fact를 echo. (격리해도 1번은 독립적으로 잔존 = 주원인.)

---

## 4. 설계 판단 — 해결됨 (2026-05-20, 사용자 결정 B)

사용자 결정 = **B (프롬프트 합성 수정)**. 단, 사용자 추가 제약
"naia-agent는 범용 — 과적합 금지·프로파일 비분기" 에 따라 **8G 전용
경로가 아닌 범용 host 제어**로 일반화하여 구현:

- `AgentOptions.appendDefaultSystemPrompt?: boolean` (default `true` →
  기존 전 host 동작 바이트 불변). Agent는 tier/model/profile **무지**,
  단일 코드경로. host가 값만 다르게(프로파일=host 레이어 소유).
- 검증: 단위 `agent-system-prompt-composition.test.ts` 4/4
  (unset/true byte-identical·persona<contract 순서·opt-out+memory).
  실측 §2 수정 후 e4b mid PASS. Claude sub-agent 적대 크로스리뷰
  PASS-WITH-FIXES(과적합·비분기·default보존 전부 CLOSED, MINOR 4건
  반영). 거버넌스 = ref-adoption-matrix §D52(범용 엔트리).
- 본인 확인법: 위 2-b 명령 그대로 → e4b mid PASS 재현. 옵션을
  끄고(소스에서 `appendDefaultSystemPrompt` 라인 제거) 재실행하면
  수정 전 0/5 FAIL로 회귀 = 인과 직접 관측 가능.

(잔여 후속(비차단): A 관대파서·C recall정책은 미채택. agent.ts
마커 주석의 모델명도 일반화 완료(#4).)

---

## 5. 정리/안전

```bash
# 벤치 종료 후 모델 언로드(선택, KEEP_ALIVE 5m 후 자동)
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"gemma3n:e4b","keep_alive":0}' >/dev/null
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader  # GPU0 회수 확인
```

- 컨테이너 자체는 사용자 정지 전까지 유지(다른 세션 영향 없음).
- GPU1은 본 작업 내내 비접촉(다른 세션 thinker용).
