# gRPC Diagnostics RPC — 신규 계약 (2026-06-13, GOAL ⑥)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e

> os F1(InteroceptivePort) rich-health(version/uptime/methods)는 os-local agentReachable 만으론 부족(F1 리뷰).
> = "구현 불가 → 신규 계약"(GOAL ⑥). agent 가 rich health 를 gRPC Diagnostics RPC 로 제공.

## 계약 (naia_agent.proto)
- `rpc Diagnostics(DiagnosticsRequest) returns (DiagnosticsResult)` (unary).
- `DiagnosticsResult { string version; int64 uptime_ms; bool healthy; repeated DiagComponent components{name,healthy} }`.

## agent 측 (이 repo — 이식 완료)
- `adapters/grpc/grpc-server.ts`: impl.diagnostics → `deps.onDiagnostics()`(미주입=기본 healthy). GrpcServerDeps.onDiagnostics.
- `adapters/diagnostics-provider.ts makeDiagnosticsProvider({version, startedAtMs, now, components})`: uptime=now-startedAt, components 정직 수집(throw=unhealthy contain), healthy=∀component. 5 단위테스트.
- entry/composition 가 onDiagnostics=makeDiagnosticsProvider(...) 주입(version=package, startedAt=기동시각, components=provider/memory health).

## os 측 (Rust client — 후속, 루크/fresh)
- os Rust gRPC client 가 Diagnostics 호출 → InteroceptivePort.diagnostics rich payload 로 매핑.
- = live 검증(cargo/cage)은 이 env 불가 → 루크 머신.

## 안전(Rust 무파손)
- os Rust = client-only codegen(canon) → proto 에 unary RPC 추가 = unused client method 생성, 빌드 무파손(UC1 동일 검증).
