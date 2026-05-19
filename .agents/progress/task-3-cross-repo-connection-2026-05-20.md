# Task #3 — Cross-repo LLM connection (naia-agent ↔ naia-adk ↔ infra) — wrap

2026-05-20 · naia-agent#41 v2 (memory) + cross-repo settings/login + CLI memory + leak hygiene.

## 미션

원래 위임: 8G 메모리 회상 메커니즘 구현·검증(Step 1-4) — Slice 8G로 종결. 사용자 재확인: **이 미션은 크로스레포**(naia-agent ↔ naia-adk/naia-settings ↔ infra). 이후 단계별 Slice A·B·C-mem + cosmetic 잔재정화(#2)까지 자율 루프(랄프, 단계별 적대 크로스리뷰)로 완주.

## 슬라이스·검증·결과

| 슬라이스 | 산출물 | 적대 크로스리뷰 | 라이브 검증 |
|---|---|---|---|
| **8G-A/B/C** (선행, #41 v2) | LiteMemoryProvider + 마커 recall + 적응형 벤치 + 프롬프트합성 범용 옵션 | PASS-WITH-FIXES ×3 (전부 반영) | e4b MID PASS 4/5·80%·20% |
| **3-XR-A** (Slice A) | `naia-settings/llm.json` 정본 소비 + `--no-tools` + dead `loadEnvAndConfig` 배선 | PASS-WITH-FIXES (5건 반영) | `provider=openai-compat model=gemma3n:e4b` |
| **3-XR-B** (Slice B) | `naia-agent login` + OS keychain(libsecret, **평문 fallback無**) + `parseRoleSpec`/`classifyProbe` 추출 | **BLOCK→6건 fix** (locale-독립 classifyProbe·평문 invariant 강화·dedup·persona/문서) | login→영속→소비 round-trip (NAIA_ADK_PATH 불요) |
| **3-XR-B.1** | safeTurn(연결오류=fatal 아닌 안내+REPL 생존) | (코드리뷰) | dead :8000 대응 깨끗 |
| **3-XR-C** (Slice C-mem) | `--memory` → 영속 LiteMemoryProvider + naia-settings `embedded` 임베더 + #41 recall | PASS-WITH-FIXES (5건 반영 — recal-strict·embed sentinel 게이트·persona 언어중립·글로벌DB disclosure·Gemini URL 가드) | 별 프로세스 cross-session 회상 정답 |
| **3-XR-D** (#2 cosmetic) | `stripRecallResidue`(line-leading·바운드·byte-identical·nullish-safe) + 라이브 스트리밍 제거(정화된 final 출력) | BLOCK→4건 fix(recap/recital 보존·문단횡단 차단·코드 byte-identical·nullish) | leak 제거, 잔여 변종은 e4b 내재(8G 합의) |

전체 단위 70+ green, 단계별 적대 크로스리뷰 모두 통과. 사용자 hands-on로 cross-process 회상 직접 확인.

## 거버넌스·SoT

- `docs/llm-config-standard.md` §3.3–3.6 (priority + naia-settings + `--no-tools` + `--memory` + `login`)
- `.agents/progress/ref-adoption-matrix.md` §D52·§D53
- `naia-adk/naia-settings/README.md` (스키마 SoT — naia-adk 소유), `llm.json` 정본 인스턴스
- F06 D1~D8 결정 불변 유지(코드주석 정직화만)

## 안전 보강 (사용자 hard line)

1. **naia-agent는 범용·과적합/프로파일분기 0**: 결함은 default-보존 범용 opt-in으로 일반화. tier/model/locale 분기 코드 0(persona·검증 완료).
2. **평문 키 0**: llm.json은 `apiKeyRef` 이름만. reader는 평문-secret-looking 키/값 검출 시 *파일 전체 거부*(invariant 실효). login은 OS keychain 불가 시 *거부*(평문 fallback 없음). 비-Linux=Null backend로 degrade.
3. **graceful**: 메모리 실패 = ephemeral 폴백(크래시 X). 모델서버 outage = REPL 생존 + 안내.
4. **invariant A**: cosmetic 잔재 strip은 OUTPUT-only, strict recall match/act에 영향 0.

## 커밋 (전부 내부, 미push→이 보고서와 함께 push)

naia-agent 본 미션 관련:
`cbb2bf4`(#41 v2 합성옵션) · `0ddcb73`(bench) · `8ccb472`(test guide) · `607df59`(--no-default-system) · `a7b7515`(Slice A) · `be9d440`(A fixes) · `c8b8ade`(safeTurn) · `72da91b`(Slice B) · `c1dfc7a`(C-mem) · `9766dad`(C-mem fixes) · `22a1c4e`(#2 BLOCK fix)
naia-adk: `3810391` · `0e8214b` · (커밋된 readme/llm.json 정본)

## 알려진 한계·미착수(정직)

- 소형모델(e4b) 임의 letter-drop 마커 가비지는 잔여 가능 — *모델 내재 한계*(8G 합의), strip은 SAFE-by-construction 유지.
- 인터랙티브 `login` UX(가이드형) 미구현 — 현재는 flag-form. 사용자 UX 우선 점검·개선 대상으로 식별됨.
- pi 내장 코딩(directive 1b) = 별도 대형 ADR 트랙([[project_naia_own_orchestrator_pi_substrate]]), 본 미션 범위 외.
- 잔여 follow-up: naia-memory `OpenAICompatEmbeddingProvider` URL `/v1` 멱등화(cross-repo 권고, 별도 리뷰).

## 다음 (사용자 지시 직격)

사용자가 부재중 점검 요청한 두 점:
1. **naia-agent CLI 유저 사용성**: flag-form 부담·`show`/inspect 부재·에러 메시지 가이드 등 — 진단·개선 후보 도출.
2. **naia-adk 설정 저장 상태**: `naia-settings/llm.json` 실저장 내용·일관성·백업안전 검토.
