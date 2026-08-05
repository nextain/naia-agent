# 사용자 소유 24GB 모델의 3레이어 적합성

## 결정

현재 제품 기본 후보는 **Qwen3.6-27B AWQ INT4 + vLLM + Pi**다. RTX 3090 GPU1 한 장에서 64K 런타임, 네이티브 툴콜, Naia-facing → 개발 moderator → 역할 팀 → 결정론 verifier → reporter 전체 경로를 실제 완주했다.

이 결론은 “Qwen이 Codex·Claude를 대체한다”는 뜻이 아니다. 사용자 소유 모델은 Naia의 대화·분배·관찰 계층 또는 비용 민감 작업자 선택지다. 어려운 설계와 고위험 구현은 구독형 Codex·Claude 또는 승인된 클라우드 모델로 위임하는 것이 제품 목표다.

## 통과 기준

후보는 다음 단계를 순서대로 통과해야 한다.

1. GPU1 단독 24GiB 안에서 최소 32K 런타임 컨텍스트로 기동한다.
2. OpenAI 호환 API가 구조화된 native tool call을 반환한다.
3. Pi가 실제 read/write 도구를 호출한다.
4. facing, moderator, explorer, implementer, tester, reviewer가 선언된 모델 영수증을 남긴다.
5. tester/reviewer의 독립 clean 사이클을 두 번 완료한다.
6. 모델 자기보고가 아니라 결정론 verifier가 정확한 산출물과 변경 파일 경계를 통과시킨다.
7. reporter가 durable evidence보다 성공 상태를 과장하지 않는다.

적재만 되거나 일반 채팅만 되는 모델은 3레이어 통과로 보지 않는다.

## 후보 판정표

| 후보 | 24GB 적재 | 32K+ | native tools | 전체 3레이어 | 제품 판정 |
|---|---:|---:|---:|---:|---|
| Qwen3.6-27B AWQ INT4 | 통과, GPU1 약 23.8GiB | 64K 기동 | 통과 | **통과** | 현재 기본 후보 |
| DeepSeek V4 Flash | 실패 | 모델 원본은 1M | 미실행 | 미실행 | 24GB 후보에서 제외 |
| EXAONE 4.5 33B Q4_K_M | 통과, 20GB GGUF | 32K 설정·원본 262K | Ollama import에서 HTTP 400 | 미통과 | 연구 비교 전용; 제품 기본값 금지 |
| DNA3.0-27B | 적합한 Linux 4-bit 정본 미확보 | 원본 262K | 공식 vLLM 경로 명시 | 미실행 | 보류 |
| DNA3.0-9B Q4_K_M | 통과, 5.78GB GGUF | 32K 설정·원본 262K | 현재 GGUF/Ollama에서 HTTP 400 | 미통과 | 저비용 한국어 challenger, serving 보강 필요 |

DeepSeek V4 Flash는 284B total/13B active 모델이다. 활성 파라미터가 작아도 전체 가중치를 저장해야 한다. 현재 공개 GGUF의 실용 최저 구간은 IQ1 계열 약 60–63GiB이고 권장 Q4_K_M-XL은 약 163GiB이므로 24GB 단일 GPU 후보가 아니다. [공식 모델 카드](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash), [GGUF 양자화 표](https://huggingface.co/teamblobfish/DeepSeek-V4-Flash-GGUF)

EXAONE 4.5 33B의 공식 Q4_K_M은 약 20GB이고 원본 컨텍스트는 262,144토큰이다. 공식 카드에는 llama.cpp와 Pi 연결 예시도 있다. 그러나 현재 Ollama 0.24 import는 capability를 `completion`만으로 판정해 tools 요청을 `does not support tools`로 거부했다. 또한 현 EXAONE 라이선스는 상업적 사용을 별도 서면 계약 없이 금지하므로 Naia 제품 기본 모델로 채택할 수 없다. [EXAONE GGUF 카드](https://huggingface.co/LGAI-EXAONE/EXAONE-4.5-33B-GGUF), [EXAONE 라이선스](https://huggingface.co/LGAI-EXAONE/EXAONE-4.5-33B/blob/main/LICENSE)

DNA3.0-27B는 Qwen3.6-27B 기반이고 DNA3.0-9B는 Qwen3.5-9B 기반이다. 둘 다 한국어 혼입·반복 감소를 장점으로 내세우고 Apache-2.0이며, 공식 9B 카드에는 `qwen3_coder` 툴 파서가 명시돼 있다. 이번에 받은 imatrix Q4_K_M은 정확히 5,780,091,296바이트로 24GB 적재 여유가 충분했지만 GGUF metadata의 chat template가 보존되지 않았다. Ollama는 이를 `TEMPLATE {{ .Prompt }}`와 `completion` capability로 가져와 native tools 요청을 HTTP 400으로 거부했다. 공식 `chat_template.jinja`에는 tool XML 계약이 있으므로 모델 능력 실패가 아니라 **현재 양자화 아티팩트와 serving 조합의 계약 실패**로 판정한다. 이 상태에서는 Pi 3레이어를 실행하지 않는다. 반면 Dnotitia 회사 지식과 정체성을 주입한 Persona Training도 포함한다. 따라서 serving을 고쳐도 Naia 정체성·계약 보존·반복 루프를 별도 적대 테스트하지 않고 main assistant로 승격하면 안 된다. [DNA3.0-27B 카드](https://huggingface.co/dnotitia/DNA3.0-27B), [DNA3.0-9B 카드](https://huggingface.co/dnotitia/DNA3.0-9B), [DNA3.0-9B GGUF](https://huggingface.co/mradermacher/DNA3.0-9B-GGUF)

다운로드한 DNA3.0-9B GGUF의 SHA-256은 `6c0146615879ec5eece3a1d7dacb0f0c37490a2d82ba801fe065920b869ebfb4`로 고정했다. 후보별 사전 게이트의 기계 판독 증거는 [`gpu1-local-model-prerequisite-probes-2026-08-05.json`](../results/gpu1-local-model-prerequisite-probes-2026-08-05.json)에 분리했다.

단, EXAONE/DNA 항목은 당시 명령·HTTP 원문·런타임 ID까지 결박한 독립 receipt가 아니라 탐색 관찰의 구조화 기록이다. 따라서 현재 조합을 **탈락**시키는 fail-closed 근거로만 사용하며 모델을 통과·순위화하는 근거로 사용하지 않는다. Qwen만 아래의 실행 결박 live receipt로 승격한다.

## Qwen GPU1 실측

실행 산출물: [`gpu1-user-owned-three-layer-live-final-2026-08-05.json`](../results/gpu1-user-owned-three-layer-live-final-2026-08-05.json)

앞선 `gpu1-user-owned-three-layer-live-2026-08-05.json`은 이미지·모델 리비전과 외부 실행 파일을
고정하기 전, `gpu1-user-owned-three-layer-live-pinned-2026-08-05.json`은 child 환경·컨테이너 내부
GPU 가시성·성공한 implementer write 결박을 보강하기 전의 역사적 결과다. 둘 다 현재 정본이 아니다.
재실행 도구는 기존 결과 경로를 덮어쓰지 않는다.

| 항목 | 결과 |
|---|---:|
| 런타임 | vLLM 0.21, Qwen3.6-27B AWQ INT4, FP8 KV, thinking off |
| GPU | GPU1만 사용 |
| 노출 / 실제 probe 컨텍스트 | 65,536 / 40,015토큰 |
| 전체 경과 | 228.680초 |
| 모델 호출 | 9회 |
| 역할 입력 / 출력 | 81,868 / 3,917토큰 |
| 역할 순서 | facing → moderator → explorer → implementer → tester → reviewer → tester → reviewer → verifier → reporter |
| clean / repair | 2 / 0 |
| 산출물 | `src/answer.js` 정확한 trimmed bytes `export const answer = 42;` |
| 변경 경계 | 허용된 새 파일 1개만 존재 |
| 결정론 검증 | 2/2 통과 |
| 최종 상태 | completed |

정본 SHA-256은 `add53801bb06859f2fff52f41d2b350bf24c41358d4e694aaac32a32ef57513d`다. 결과는 현재 TypeScript import closure와 실행된 dist가 byte-exact emission임을 확인하고 각각의 SHA-256을 보존한다. 또한 Pi 실행 파일과 Git·Podman·nvidia-smi·ss의 절대 경로/해시, vLLM 0.21 이미지 ID와 digest, Qwen snapshot `e5cc0400fb2403c437c2c40a7c52fb5ae93fda18`, 14개 파일·20,467,159,060바이트의 manifest digest `470b8c41dd0e081c2ff76c7b59fde266c875906942dc5ae4c33e89e3ec2df3c6`, 비특권 컨테이너 내부에서 단 하나만 보이는 GPU와 호스트 GPU1에 일치하는 UUID, 23,818/24,576MiB telemetry, 127.0.0.1:8000 listener의 Podman network namespace, 40,015-token 실제 요청을 결박했다. OpenAI protocol proxy는 30개 native tool call을 보존하며, implementer의 성공한 `write` 대상은 해당 임시 worktree의 `src/answer.js`, 내용 SHA-256은 `a2098bd92b10bf8b816d24b7556b1ce8c49a879d130489065ef1051c17e042f6`이다.

로컬 모델의 Pi catalog 가격은 0으로 두지만 이를 Azure나 전력 비용 0으로 해석하지 않는다. 공급자 가격 영수증이 없으므로 issue total cost는 `unavailable`로 유지했고, `providerCostNotFaked` 게이트가 이를 확인했다.

## 실험 중 차단한 드리프트

첫 유효 직전 실행은 [`gpu1-user-owned-three-layer-rejected-budget-drift-2026-08-05.json`](../results/gpu1-user-owned-three-layer-rejected-budget-drift-2026-08-05.json)에 보존했다.

- 모델이 정확한 ES module 바이트 요구를 CommonJS의 의미상 동등 구현으로 완화했다.
- tester와 reviewer가 실제 파일을 읽고도 그 완화를 잘못 clean으로 승인했다.
- 거부 산출물은 마지막 reviewer receipt의 입력 16,090토큰과 최종 실패를 보존한다. 다만 당시
  16,000토큰 예약 및 typed rejection reason을 같은 JSON에 보존하지 않았으므로 둘 사이의 인과는
  정본 증명으로 사용하지 않는다.
- 수정 후 exact syntax/bytes/path/negative constraint를 동등 구현으로 치환하지 못하게 역할 계약을 강화했다.
- 예약 단위는 관측된 긴 역할 입력을 수용하도록 32K로 올렸고 전체 durable budget은 384K로 고정했다.
- 최종 성공은 역할 자기보고와 무관하게 exact-byte verifier와 changed-file verifier가 결정했다.

229초 완주 결과는 루프 전체에 2분 상한이 없음을 실증한다. 코드의 120초 값은 facing/moderator/reporter **개별 호출**의 hang 안전장치이며, 역할 루프 전체 종료 시간이 아니다. 이전 실패 산출물만으로는 typed 실패 원인을 다시 판정할 수 없으므로 예약 초과 인과는 향후 typed rejection receipt가 있는 실행에서만 주장한다.

## 제품 적용 순서

1. Qwen3.6-27B 64K를 사용자 소유 모델 프로파일의 기준선으로 유지한다.
2. Naia main assistant와 역할 coding agent를 같은 모델로 강제하지 않는다. 프로파일이 Codex/Claude/OpenCode/Pi를 역할별로 선택한다.
3. DNA3.0-9B는 공식 Jinja tool template를 보존하는 llama.cpp/vLLM serving을 먼저 고정한 뒤 한국어·비용 challenger로만 실행하고 identity drift, obligation preservation, two-clean loop를 Qwen과 같은 runner에서 비교한다.
4. DNA3.0-27B는 Linux에서 재현 가능한 4-bit 아티팩트와 라이선스·해시가 고정된 뒤 평가한다.
5. EXAONE은 상용 라이선스가 확보되지 않는 한 연구 벤치 밖으로 승격하지 않는다.
6. DeepSeek V4 Flash 로컬 가중치는 24GB 범위에서 제외하고 Azure 같은 클라우드 프로파일로만 비교한다.

## 재현 경계

runner는 credential-free loopback endpoint만 허용하고 그 listener를 선언 Podman network namespace와 결박한다. endpoint 모델/root, 고정 이미지와 모델 snapshot, 컨테이너 명령, GPU device/telemetry, 40K 실제 요청, native tool protocol, 현재 source/dist/Pi/외부 실행 파일 해시를 함께 확인한다. 기존 출력이나 동시 실행 claim이 있으면 모델 I/O 전에 실패한다. 부모 프로세스의 클라우드 자격증명은 Pi child와 Git·런타임 검사 자식에 상속하지 않는다.

```bash
NAIA_LOCAL_OPENAI_BASE_URL=http://127.0.0.1:8000/v1 \
NAIA_LOCAL_PROVIDER=local-vllm \
NAIA_LOCAL_MODEL=naia-0.9-coding-24g \
NAIA_LOCAL_GPU_INDEX=1 \
NAIA_LOCAL_RUNTIME_CONTAINER=naia-coding-64k-gpu1-pinned \
node benchmark/run-user-owned-three-layer-live.mjs \
  --output benchmark/results/gpu1-user-owned-three-layer-live-final-2026-08-05.json
```

이 단일 과제 결과를 일반 코딩 성능 우위로 확대하지 않는다. 다음 비교 코퍼스에는 다중 파일 수정, 실패 수리, 모호한 요구, 장문 저장소 탐색, 병렬 이슈가 필요하다.
