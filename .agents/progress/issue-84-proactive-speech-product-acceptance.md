# Issue #84 — 선제 발화 profile 제품 검증

## 현재 증적

- 구현: agent `8afe8d3`, shell `4bb9d2d1`
- 실제 Tauri 시작 경로: shell `d5ed59be`
- native 검증됨: profile 저장·복원, DJ 실제 YouTube BGM·첫 결과·stop, 전시 greeting·stop
- 계약/통합 검증됨: DJ 멘트·제어·lease/race, 전시 소개·yield/resume·stale 폐기

## 남은 완료 조건

- audible proactive TTS와 두 번 이상의 live DJ 멘트
- music-only/talk-less/change-vibe/next와 live 끼어들기
- 전시 질문 중단→근거 답변→resume, quiet/restart/stop, stale audio 폐기
- 명시적 음악 선호의 Naia Memory 영속 handoff
- 기분/활동의 명시적 수집 흐름과 사용자용 날씨 위치·동의 UI
- 장시간 품질 테스트와 전시 KB 현장 리허설

REQ-013과 P05는 위 조건과 세 문서 영향 재검토가 끝날 때까지 Partial/Pending이다.
