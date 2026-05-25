# Plan: naia-os 캡슐화 — config_update IPC

Date: 2026-05-25
Status: PLANNING
Depends: Phase 1-5 (완료), F1-F4 (완료)

---

## 1. 문제

naia-os가 naia-agent의 내부 파일(config.json, keychain, llm.json 등)을 **직접 쓰기** — 캡슐화 위반.

naia-agent는 자기 파일의 유일한 작성자여야 함. naia-os는 IPC로만 요청.

## 2. 현재 위반 건수

| 도메인 | 쓰기 건수 | 영향 |
|--------|-----------|------|
| `naia-settings/config.json` | 7 call sites | provider, model, persona 설정 |
| OS keychain + `.keys/` | 3 call sites | API 키 저장 |
| `~/.naia/memory-config.json` | 1 | 메모리 설정 |
| `auth-profiles.json` | 1 | 게이트웨이 인증 |
| `SOUL/IDENTITY/USER.md` | 3 | 워크스페이스 부트스트랩 |
| `~/.naia/adk-path` | 1 | ADK 경로 캐시 |
| **총 16건** (naia-agent 도메인) | | |

## 3. 해결: config_update IPC 프로토콜

### 3.1 프로토콜

```
naia-os (stdin) → naia-agent:
{
  "type": "config_update",
  "id": "uuid-4",
  "config": { "NAIA_MAIN_PROVIDER": "naia", ... },
  "secrets": { "NAIA_ANYLLM_API_KEY": "gw-xxx", ... }   // optional
}

naia-agent → naia-os (stdout):
{
  "type": "config_update_response",
  "id": "uuid-4",
  "status": "ok" | "error",
  "error": "..." // status=error일 때만
}
```

- `config`: config.json에 머지할 키-값
- `secrets`: OS keychain에 저장할 키-값 (config.json에 평문 저장 금지)

### 3.2 naia-agent 핸들러

`runStdio()`의 message handler에 `config_update` case 추가:

1. `msg.config` → `readNaiaSettings()` 읽기 → 머지 → `writeNaiaSettings()`
2. `msg.secrets` → `saveApiKeys()`로 OS keychain 저장
3. `cachedLlm = undefined` (캐시 무효화)
4. `loadEnvAndConfig()` 재호출 (env 갱신)
5. 응답 전송

### 3.3 naia-os 측 변경

| 기존 | 변경 |
|------|------|
| `writeNaiaConfig()` → Rust `write_naia_config` | `sendConfigUpdate()` → stdio IPC |
| `writeAgentKey()` → Rust `write_agent_key` | `sendConfigUpdate({ secrets })` |
| `write_naia_path_cache()` → Rust | 초기 설치시에만 사용 (논-에이전트 도메인) |

### 3.4 논-에이전트 도메인 (변경 불필요)

| 파일 | 소유 | 변경 |
|------|------|------|
| `naia-settings/vrm-files/`, `background/`, `bgm-musics/` | naia-os (UI 에셋) | 유지 |
| `naia-discord.json` | naia-os (shell 자체) | 유지 |
| `init_naia_settings()` (디렉토리 생성) | 부트스트랩 | 유지 |

## 4. 작업 항목

| ID | 작업 | 범위 | 의존 |
|----|------|------|------|
| C1 | `config_update` IPC 핸들러 (naia-agent) | bin/naia-agent.ts | 없음 |
| C2 | `config_update_response` 응답 타입 추가 | packages/protocol | C1 |
| C3 | `sendConfigUpdate()` 함수 (naia-os) | shell/src/lib/adk-store.ts | C1 |
| C4 | `writeNaiaConfig()` → `sendConfigUpdate()` 교체 (7 call sites) | naia-os TS | C3 |
| C5 | `writeAgentKey()` → `sendConfigUpdate({ secrets })` 교체 | naia-os TS | C3 |
| C6 | `config_update` 시나리오 테스트 | packages/cli-app | C1 |
| C7 | `stripForAgent()` — 점진적 제거 | naia-os | C4 |

## 5. 의존 관계

```
C1 (agent 핸들러) ──→ C2 (protocol 타입)
                  ──→ C6 (테스트)
C1 ──→ C3 (os sendConfigUpdate) ──→ C4 (writeNaiaConfig 교체)
                                ──→ C5 (writeAgentKey 교체)
C4 ──→ C7 (stripForAgent 제거)
```

## 6. 완료 기준

1. `config_update` IPC로 config.json + keychain 업데이트 동작
2. naia-os가 `write_naia_config` / `write_agent_key` 직접 호출 제거
3. naia-agent 단독 실행 시 기존 파일 기반 동작 변경 없음
4. 전체 테스트 통과 (naia-agent 235+, naia-os 685+)

## 7. 리스크

- **C1-C2만 먼저**: naia-agent 핸들러만 추가하고 naia-os는 나중에 교체 가능 (IPC 미사용 시 무해)
- **Keychain 접근**: naia-agent가 keychain 쓰기 가능해야 함 (현재 `keychainSet` 이미 있음)
- **Rust 명령 잔존**: `write_naia_config` Rust 명령은 deprecated 표시 후 다음 릴리스에서 제거
