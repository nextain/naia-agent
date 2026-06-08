<!-- src-sha: d458c10b9c96b4f0 -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/project-index.yaml -->

# naia-agent 컨텍스트 가이드

**프로젝트**: naia-agent (naia 생태계 허브 런타임)  
**버전**: 0.1.0  
**마지막 업데이트**: 2026-06-08

---

## 개요

naia 생태계 허브 런타임 (검색-생성 통합(RAG), 컨텍스트 관리, 장기기억 담당) — 깔끔한 재구축 (육각형 아키텍처(Hexagonal Architecture) 이식)

---

## 세션 시작 시 반드시 읽을 파일 (순서 중요)

1. **`.agents/context/process-status.json`**
   - 현재 이슈와 소프트웨어 개발 생명주기(SDLC) 게이트 상태 기록
   - 반드시 `last_updated` 필드를 갱신하고 시작

2. **`.agents/context/agents-rules.json`**
   - 규칙의 정본(Source of Truth, SoT)
   - 모든 금지 사항과 필수 사항 확인

3. **`docs/project-structure.md`**
   - 허용된 루트 디렉토리와 파일 구조 명세

---

## 진입점

- **`AGENTS.md`** — 인공지능 도구 통합 체계의 진입점 (정본)
- **`CLAUDE.md`** — Claude Code용 미러

---

## 필요할 때만 읽기 (온디맨드 로딩)

### 프로세스 및 설계 관련

| 파일 | 주제 |
|------|------|
| `docs/user-scenarios.md` | 사용 사례(UC), 사용자 시나리오, 테스트 커버리지 맵 |
| `docs/requirements.md` | 기능 요구사항(FR), 비기능 요구사항(NFR) |
| `docs/glossary.md` | 용어사전 |

### 아키텍처 관련

| 파일 | 주제 |
|------|------|
| `docs/ARCHITECTURE.md` | 시스템 아키텍처, 패키지 맵, 의존성 |

### 활동 중인 이슈

| 파일 | 주제 |
|------|------|
| `.agents/progress/` | 진행 중인 이슈, 소프트웨어 개발 생명주기(SDLC) 상태 |

### 격리된 자산 (검토 대기)

| 파일 | 설명 |
|------|------|
| `quarantine/MANIFEST.json` | 검토 대기 중인 자산 목록. 비어있지 않으면 대기 중인 백업 자산이 존재. `scripts/quarantine.mjs`를 통해 관리 |

---

## 컨텍스트 정본 우선순위

1. `.agents/context/agents-rules.json`
2. `AGENTS.md`
3. `.agents/context/project-index.yaml`
