# Phase 2 Day 1.0 — ACP handshake spike findings (2026-04-26)

## Smoke command

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | opencode acp
```

## Response (verified working)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": { "http": true, "sse": true },
      "promptCapabilities": {
        "embeddedContext": true,
        "image": true
      },
      "sessionCapabilities": {
        "fork": {},
        "list": {},
        "resume": {}
      }
    },
    "authMethods": [
      {
        "description": "Run `opencode auth login` in the terminal",
        "name": "Login with opencode",
        "id": "opencode-login"
      }
    ],
    "agentInfo": { "name": "OpenCode", "version": "1.14.25" }
  }
}
```

## 검증 결과

| 항목 | 상태 | 비고 |
|---|:---:|---|
| ACP protocol v1 | ✓ | matrix D24 정합 |
| `initialize` handshake | ✓ | request/response 정상, 1초 미만 응답 |
| `loadSession` capability | ✓ | (Phase 3에서 활용 가능) |
| MCP support (http+sse) | ✓ | (deferred — D08 채택 후 활용) |
| `embeddedContext` + image | ✓ | (Phase 4 multi-modal stream에 활용) |
| **`fork`** session capability | ✓ | (Phase 3 sub-session 분기 가능) |
| **`list`** session capability | ✓ | (Phase 3 sub-session 카드 view 활용) |
| **`resume`** session capability | ✓ | (Phase 3 long-running task 재개 가능) |
| **`pause`** session capability | ✗ | **미지원** — Reference P0-1 + Paranoid P0-3 음성 확인 |

## 결정 (D39 — Phase 2 Day 3.1 spike 사전 결정)

**opencode ACP는 `pause`를 지원하지 않음**. 따라서:

- `OpencodeAcpAdapter.pause()` → `UnsupportedError` throw 유지 (Phase 1 contract 동일)
- `OpencodeAcpAdapter.resume()` → Phase 3에서 정식 검토 (long-running session 재개 시나리오)
- adapter-contract.md §3 unsupported matrix 갱신:
  - opencode-acp: pause ✗ / resume △ (Phase 3) / inject ✗
- Day 3.1 spike 시간은 30분으로 단축 (이미 spike 완료, docs 작성만)

## Day 1.0 후속 액션

| step | 결과 |
|---|---|
| Day 1.1 (pkg 신설) | 진행 |
| Day 1.2 (AcpClient + crash recovery test) | 진행 |
| Day 1.3 (OpencodeAcpAdapter + tool context env) | 진행 |
| Day 1.4 (events() + redact wrapper) | 진행 |
| Day 1.5 (unit test C1~C13) | 진행 |
| Day 3.1 (pause/resume spike) | 본 spike로 일부 처리 — 30분 단축 |

## ACP server 동작 방식 정리

- **stdio mode**: stdin에서 JSON-RPC request 읽기, stdout으로 response/notification 쓰기
- **bidirectional**: server (opencode) ↔ client (naia-agent)
  - client → server: `initialize`, `session/new`, `session/prompt`, `session/cancel`
  - server → client (notification): `session/update`
  - server → client (request): `session/request_permission` (sub-agent가 사용자 승인 요구)
- **EOF 처리**: stdin 닫힘 → opencode acp graceful shutdown
- **process.kill(SIGTERM)**: 즉시 종료 (Day 1.2 unit test에서 검증)

## 다음 spike 필요 항목

| 항목 | 시점 |
|---|---|
| `session/new` 실 호출 + sessionId 반환 | Day 1.3 (구현 중 검증) |
| `session/prompt` long-running + 다량 `session/update` | Day 1.5 unit test (mock server) |
| `session/request_permission` 실 발생 시나리오 | Day 2.4 (file write tool) |
| `session/cancel` graceful timing | Day 1.5 + Day 2 contract test C12 |
| ACP server crash mid-session | Day 1.2 unit test (Paranoid P0-1) |

## 참조

- ref opencode `/var/home/luke/alpha-adk/projects/refs/ref-opencode/packages/opencode/src/acp/agent.ts:533-616` — `initialize()` 실 구현
- spec: r4-phase-2-spec.md Day 1.0 obligatory smoke
- decision: 매트릭스 §D D39 (opencode ACP pause unsupported)
