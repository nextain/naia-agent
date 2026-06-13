// adapters/diagnostics-provider — F1 rich-health 의 onDiagnostics(gRPC Diagnostics RPC). 신규계약(GOAL ⑥).
// agent version/uptime/component health 산출. now/startedAt 주입(순수-ish, 테스트 가능). os InteroceptivePort rich payload.
import type { DiagnosticsResult } from "./grpc/grpc-server.js";

export interface DiagnosticsProviderDeps {
  version: string;                       // agent 버전(package.json 등 entry 주입)
  startedAtMs: number;                   // 기동 시각(uptime 계산)
  now: () => number;                     // 현재 시각(테스트 주입)
  /** 컴포넌트 health 조회(provider/memory 등). 미주입=빈. 각 throw 안전(try). */
  components?: () => readonly { name: string; healthy: boolean }[];
}

/** onDiagnostics 구현 — uptime=now-startedAt, components 정직 수집(throw=unhealthy 로 contain). */
export function makeDiagnosticsProvider(d: DiagnosticsProviderDeps): () => DiagnosticsResult {
  return () => {
    let components: readonly { name: string; healthy: boolean }[] = [];
    try { components = d.components ? d.components() : []; } catch { components = [{ name: "components", healthy: false }]; }
    const uptimeMs = Math.max(0, d.now() - d.startedAtMs);
    // healthy = 모든 컴포넌트 healthy(빈=모름이 아니라 agent 자체는 응답 중이므로 healthy=true; 컴포넌트 unhealthy 있으면 false).
    const healthy = components.every((c) => c.healthy);
    return { version: d.version, uptimeMs, healthy, components };
  };
}
