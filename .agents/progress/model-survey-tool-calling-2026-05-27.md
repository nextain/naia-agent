# LLM 비교 조사 2 — Tool Calling / Structured JSON / Document Analysis
# GLM-4.7-Flash · Gemini Flash (2.0/2.5) · Claude Haiku 4.5

**날짜**: 2026-05-27
**맥락**: naia-agent multi-judge ensemble (3-XR-H) 및 향후 provider 선택을 위한 객관 조사.
**범위 기준 (2026-05-27 사용자 지시)**: API 기반 소형/중형 모델로 한정. Ollama(로컬) 제외. o4-mini / GPT-4o-mini 제외.
**비교 대상**: GLM-4.7-Flash / Gemini 2.0 Flash / Gemini 2.5 Flash / Claude Haiku 4.5.

---

## 1. 모델 기본 스펙 요약

| 항목 | GLM-4.7-Flash | Gemini 2.0 Flash | Gemini 2.5 Flash | Claude Haiku 4.5 |
|------|---------------|------------------|------------------|-----------------|
| 출시일 | 2026-01-19 | 2025-02 | 2025-05-20 | 2025-10 |
| 제공사 | Z.AI (Zhipu AI) | Google | Google | Anthropic |
| 아키텍처 | 30B-A3B MoE | 비공개 | 비공개 (hybrid reasoning) | 비공개 |
| 컨텍스트 창(입력) | 128K (API) / 200K (HF) | 1M | 1M | 200K |
| 최대 출력 | 16,384 | 8,192 | 65,536 | 비공개 |
| 모달리티 | **텍스트 전용** (이미지 미지원) | 텍스트+이미지+오디오+영상 | 텍스트+이미지+오디오+영상 | 텍스트+이미지+파일 |
| 라이선스 | MIT (오픈웨이트) | 상용 API | 상용 API | 상용 API |
| 입력 단가 ($/1M tok) | $0.07 | ~$0.10 | $0.30 | $1.00 |
| 출력 단가 ($/1M tok) | $0.40 | ~$0.40 | $2.50 | $5.00 |
| 속도 (t/s) | 79.8 | 미측정 | **225.4** | ~97 |

**주의**: GLM-4.7-Flash는 2026-05-13 기준 일부 집계 사이트(llm-stats.com)에서 deprecated 표시됨.

---

## 2. Tool Calling (Function Calling) 지원 여부

### 2-1. GLM-4.7-Flash

- **지원**: OpenAI-compat API 포맷으로 function calling 지원.
- vLLM 배포 시 `--tool-call-parser glm47 --enable-auto-tool-choice` 필요.
- SGLang도 동일 지원 (main branch 최신 필요).
- τ²-Bench(Multi-turn agentic tool use) **0.795** — 현재 공개 벤치 중 4위, Step-3.5-Flash(0.882) · GLM-4.7(0.874) · MiMo-V2-Flash(0.803) 다음.
- **알려진 이슈**: vLLM 0.16.0에서 `tool_calls` 필드 미반환 버그 보고 (GitHub issue #36833). 최신 vLLM 버전 또는 SGLang 사용 권장.
- "Preserved Thinking mode" 활성 시 multi-turn 도구 호출에서 reasoning 유지 (τ²-Bench 측정 전제).

### 2-2. Gemini 2.0 Flash

- **지원**: function calling 전면 지원. OpenAPI-compat JSON Schema + Python docstring 방식 모두.
- **제약**: `anyOf` 타입 JSON Schema 미지원.
- JSON mode(`response_mime_type='application/json'`) + tool calling 동시 사용 가능 (2.5에서 회귀된 기능이 2.0에서는 정상).
- 공개 τ-bench / BFCL 점수: 이 조사 범위에서 공식 수치 미확인.

### 2-3. Gemini 2.5 Flash

- **지원**: function calling 지원.
- **중요 회귀 버그**: tool call이 메시지 이력에 존재할 때 structured output(`response_mime_type='application/json'`) 동시 사용 불가. 에러: `"Function calling with a response mime type: 'application/json' is unsupported"`.
  - GitHub googleapis/python-genai #706 — 2025-04-25 closed, 그러나 이후 재현 보고 계속 (05-20, 08월 댓글).
  - **근본 원인**: JSON schema가 tool call 형식 emission을 막음. Google 공식 확인.
  - **워크어라운드**: `response_mime_type` 제거 후 응답을 수동 파싱 (plain text 또는 markdown-wrapped JSON).
- 1M 컨텍스트 + 멀티모달 강점. SWE-bench Verified 0.604, GPQA 0.828, MMMU 0.797, AIME 2025 0.72.

### 2-4. Claude Haiku 4.5

- **지원**: tool use (function calling) 전면 지원. Anthropic API + Amazon Bedrock + Google Vertex AI.
- **structured outputs**: JSON Schema 네이티브 지원 GA (Haiku 4.5부터 공식 지원 — 3.5 대비 instruction following 및 JSON 유효성 대폭 향상).
- tool call + JSON output 동시 사용: **지원** (Gemini 2.5 Flash의 버그와 달리 제약 없음).
- **멀티에이전트 특화**: 저지연 서브에이전트 역할에 최적화. 4개 provider 모두 function calling 지원.
- **속도**: ~97 t/s (Anthropic 직접 API 기준).
- **알려진 특성**: 출력 길이가 Sonnet/Opus보다 짧아 긴 응답 태스크에 제약. 라우팅·분류·도구 실행 루프에 최적.

---

## 3. Structured JSON Output 능력

### 3-1. GLM-4.7-Flash

- **JSON mode**: `response_format={"type": "json_object"}` 지원. GLM-4.7, 4.5, 4.6, 4.7-Flash 모두 포함.
- **JSON Schema**: `response_format`에 JSON Schema 직접 지정 가능 → schema 엄격 준수.
- Z.AI 공식 문서(docs.z.ai/guides/capabilities/struct-output): nested array/object, validation rule 포함한 복잡한 스키마 지원.
- **trade-off**: 복잡한 시나리오에서 응답 자연스러움(naturalness) 저하 가능성 문서화됨.
- tool calling + JSON output 동시 사용 시 명시적 이슈 없음 (Gemini 2.5와 달리).

### 3-2. Gemini 2.0 Flash

- `response_mime_type='application/json'` + tool calling 동시 사용 정상.
- JSON mode 및 schema 출력 지원.

### 3-3. Gemini 2.5 Flash

- JSON mode 자체는 지원.
- **치명적 제약**: tool messages가 conversation history에 있을 때 JSON mode 병용 불가 (§2-3 참조).
- agentic workflow(tool loop → JSON 결과 추출)가 필요한 경우 Gemini 2.0 Flash 또는 다른 모델 우선 고려.

### 3-4. Claude Haiku 4.5

- **JSON Schema 네이티브 structured output**: GA. API 응답이 schema를 정확히 따름을 보장.
- **JSON mode**: tool use를 JSON 출력 wrapper로 활용하는 방식 또는 system prompt 지시 방식 모두 유효.
- tool call + JSON schema output 동시 지원 — 버그/제약 없음.
- **provider 지원**: Anthropic API + Vertex AI = JSON mode 지원. Bedrock = function calling 지원.
- Haiku 3.5 대비 instruction following 및 JSON 유효성 대폭 향상 (Anthropic 공식 발표).

---

## 4. Document Analysis 태스크 성능

### 4-1. GLM-4.7-Flash

- **텍스트 전용** — PDF/이미지 문서 직접 처리 불가. 텍스트 추출 후 입력 필요.
- 장점: 128K(API)/200K(HF) 컨텍스트 → 긴 텍스트 문서 처리 가능.
- 관련 벤치: GPQA 0.752, BrowseComp 0.428.
- **참고**: Z.AI 생태계에는 별도 GLM-OCR 모델(0.9B, OmniDocBench 1.5 94.6 1위) 존재 → 문서 OCR은 GLM-OCR 분리 파이프라인 구성 필요.
- GLM-4.7-Flash의 텍스트 문서 분석(요약·추출·QA)은 128K 컨텍스트 + structured output 조합으로 강함. 단, 이미지/표 포함 문서는 별도 전처리 필수.

### 4-2. Gemini 2.0 Flash

- 멀티모달 지원 → PDF 이미지, 표, 차트 직접 처리 가능.
- 1M 컨텍스트 → 대용량 문서 코퍼스 처리 우수.
- 공식 DocVQA, MMMU 점수: 이 조사 범위에서 미확인 (2.5와 함께 집계 사이트에 미등재).

### 4-3. Gemini 2.5 Flash

- 멀티모달(텍스트+이미지+오디오+영상) + 1M 컨텍스트 → 복합 문서 분석 강점.
- **공식 벤치**: MMMU 0.797, FACTS Grounding 0.853, GPQA 0.828.
- 비공식 DocVQA 점수: 미확인 (2.5 Flash 기준). Pro 모델은 88.1%.
- **주의**: tool calling + JSON output 제약(§2-3)으로 agentic 문서 추출 파이프라인 구성 시 2.0 Flash가 더 안정적.

### 4-4. Claude Haiku 4.5

- 텍스트+이미지+파일(PDF, CSV 등) 멀티모달 지원.
- 200K 컨텍스트 → 대용량 문서 처리 가능.
- **공식 벤치**: SWE-bench Verified **0.733** (Haiku 4.5 기준 — Haiku 3.5의 0.406 대비 대폭 향상), GPQA 미공개(Haiku tier).
- 문서 추출·요약·분류 등 구조화 태스크에서 JSON output 안정성 강점.
- DocVQA 공식 점수: 미확인 (Haiku 4.5 기준 집계 미등재).

---

## 5. 4-모델 종합 비교 매트릭스

| 항목 | GLM-4.7-Flash | Gemini 2.0 Flash | Gemini 2.5 Flash | Claude Haiku 4.5 |
|------|:---:|:---:|:---:|:---:|
| Tool calling 기본 지원 | O | O | O | O |
| Tool call + JSON output 동시 | O | O | **X (버그)** | O |
| JSON Schema strict output | O | O | O* | O |
| Multi-turn agentic (τ²-Bench) | **0.795** | 미확인 | 미확인† | 미확인 |
| 이미지/PDF 직접 처리 | **X** | O | O | O |
| 컨텍스트 창 | 128K / 200K | 1M | 1M | 200K |
| 추론(reasoning) | O (CoT) | O | O (hybrid) | O |
| GPQA | 0.752 | 미확인 | **0.828** | 미확인 (Haiku tier) |
| SWE-bench Verified | 0.592 | 미확인 | 0.604 | **0.733** |
| MMMU (multimodal) | N/A | 미확인 | 0.797 | 미확인 |
| 입력 단가 ($/1M) | **$0.07** | ~$0.10 | $0.30 | $1.00 |
| 출력 단가 ($/1M) | **$0.40** | ~$0.40 | $2.50 | $5.00 |
| 속도 (t/s) | 79.8 | 미측정 | **225.4** | ~97 |
| 오픈웨이트 | **O (MIT)** | X | X | X |

*Gemini 2.5 Flash JSON Schema는 tool history 없을 때만 안정.
†Gemini 2.5 Flash τ-bench 점수 = HAL 대시보드 등재 확인, 수치 미확인.

---

## 6. naia-agent 적용 관점 시사점

### 6-1. Multi-judge ensemble (3-XR-H 현재 구성)

현재 `defaultEnsemble = GLM HTTP + opencode CLI + codex CLI + gemini CLI`.

- **GLM-4.7-Flash**: judge 역할 적합. tool calling + JSON output 동시 사용 안정. 저렴($0.07/$0.40). 단, deprecated 경고 → Z.AI의 후속 모델(GLM-4.7, GLM-4.5 등) 마이그레이션 경로 확인 필요.
- **Gemini 2.5 Flash**: judge가 JSON 출력을 tool call 이후 반환해야 하는 경우 2.5 Flash 사용 위험. Gemini CLI는 텍스트 응답 기반으로 judge 호출하므로 현재 구성(CLI)에서는 직접 영향 없음. API 직접 호출로 바꾸면 버그 노출 가능. 안정성 우선 시 **2.0 Flash 권장**.
- **Claude Haiku 4.5 (Anthropic API)**: judge 역할 적합. tool call + JSON output 동시 사용 안정. SWE-bench 0.733으로 코딩/분석 판단 품질 우수. $1.00/$5.00 — GLM 대비 고가이나 Anthropic 생태계 native judge 로 신뢰도 높음. multi-agent 서브에이전트 역할에도 최적.

### 6-2. Document Analysis 파이프라인 (미래 슬라이스)

- 텍스트 추출된 문서(txt/md) → GLM-4.7-Flash 128K 컨텍스트 + JSON Schema output: 저비용 대안.
- 이미지/PDF 네이티브 처리 필요 → Gemini 2.5 Flash (멀티모달, 1M ctx) 우선. 단 JSON output + tool call 동시 사용 시 **2.0 Flash fallback**.
- Anthropic 생태계 내 문서 처리 → Claude Haiku 4.5 (PDF 직접 파일 입력 + 200K ctx + JSON output 안정).

### 6-3. 비용/성능 최적 조합 (참고)

```
저비용 텍스트 분석:     GLM-4.7-Flash ($0.07/$0.40)
멀티모달 대용량:        Gemini 2.5 Flash ($0.30/$2.50) — tool+JSON 버그 주의
속도 우선 멀티모달:     Gemini 2.5 Flash (225.4 t/s, 1M ctx)
Anthropic 생태계 judge: Claude Haiku 4.5 ($1.00/$5.00, SWE-bench 0.733)
tool+JSON 안정 멀티모달: Gemini 2.0 Flash (~$0.10/$0.40)
```

---

## 7. 정직한 한계 / 주의사항

1. **τ²-Bench 비교 불완전**: GLM-4.7-Flash(0.795)는 공식 집계됨. Gemini 2.5 Flash와 Claude Haiku 4.5는 같은 벤치 공식 수치 미확인(별도 조사 필요).
2. **DocVQA 점수 공백**: 4개 모델 모두 공개 DocVQA 점수 미수집. 집계 사이트(llm-stats.com DocVQA)에 미등재.
3. **Gemini 2.5 Flash JSON+Tool 버그 상태 유동**: 2025-04-25 closed 후 재현 보고 계속. 최신 SDK 버전 + 실측 검증 필수.
4. **GLM-4.7-Flash deprecated 경고**: 2026-05-13 이후 일부 API 집계에서 deprecated. Z.AI 공식 문서(docs.z.ai)는 정상 제공 중. 장기 사용 시 후속 모델 확인 요.
5. **Claude Haiku 4.5 비용**: GLM-4.7-Flash($0.07/$0.40) 대비 14×/12.5× 고가. 고빈도 judge 호출 시 비용 영향 계산 필요. 대안: judge 역할에 GLM + 최종 판정에만 Haiku 4.5 투입하는 tier 구성.
6. **Gemini 2.0 Flash vs 2.5 Flash**: document 분석 + tool calling 안정성 관점에서 2.0이 현재 더 안전. 2.5는 reasoning 향상(GPQA 0.828)으로 판단 품질 우위.
7. **Claude Haiku 4.5 GPQA 미공개**: Anthropic은 Haiku tier의 GPQA 점수를 공식 발표하지 않음. Opus 4.6(0.913)·Sonnet 4.6 기준은 있으나 Haiku 4.5 독립 수치 미확인.

---

## 8. 출처

- [GLM-4.7-Flash HuggingFace](https://huggingface.co/zai-org/GLM-4.7-Flash)
- [GLM-4.7-Flash — llm-stats.com](https://llm-stats.com/models/glm-4.7-flash)
- [GLM-4.7-Flash — artificialanalysis.ai](https://artificialanalysis.ai/models/glm-4-7-flash)
- [GLM Structured Output — Z.AI docs](https://docs.z.ai/guides/capabilities/struct-output)
- [vLLM tool_calls bug #36833](https://github.com/vllm-project/vllm/issues/36833)
- [Tau-bench leaderboard — llm-stats.com](https://llm-stats.com/benchmarks/tau-bench)
- [Gemini 2.5 Flash — llm-stats.com](https://llm-stats.com/models/gemini-2.5-flash)
- [Gemini 2.5 Flash — artificialanalysis.ai](https://artificialanalysis.ai/models/gemini-2-5-flash)
- [Gemini 2.5 structured output + tool calling bug (python-genai #706)](https://github.com/googleapis/python-genai/issues/706)
- [Gemini 2.5 JSON+Tool bug (litellm #10134)](https://github.com/BerriAI/litellm/issues/10134)
- [Gemini 2.5 Flash model card (PDF)](https://storage.googleapis.com/model-cards/documents/gemini-2.5-flash.pdf)
- [Claude Haiku 4.5 — artificialanalysis.ai](https://artificialanalysis.ai/models/claude-4-5-haiku)
- [Claude Haiku 4.5 — Caylent deep dive](https://caylent.com/blog/claude-haiku-4-5-deep-dive-cost-capabilities-and-the-multi-agent-opportunity)
- [Claude Haiku 4.5 — pricepertoken.com](https://pricepertoken.com/pricing-page/model/anthropic-claude-haiku-4.5)
- [Claude Structured Outputs GA — Anthropic blog](https://claude.com/blog/structured-outputs-on-the-claude-developer-platform)
- [Claude Benchmarks 2026 — morphllm.com](https://www.morphllm.com/claude-benchmarks)
- [Agentic AI Benchmarks Leaderboard — awesomeagents.ai](https://awesomeagents.ai/leaderboards/agentic-ai-benchmarks-leaderboard/)
- [Berkeley BFCL V4](https://gorilla.cs.berkeley.edu/leaderboard.html)
