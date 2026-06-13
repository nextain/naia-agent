// adapters/diagnostic — 표준 진단 로깅 sink (DiagnosticLog 구현). 에이전트의 **유일한** 로그 sink.
//
// 로깅 규약(docs/logging.md): 코어/앱/어댑터는 DiagnosticLog 포트로만 로깅한다. `console.*`/직접 stdout·stderr
// write 는 금지(scripts/check-logging.mjs 가 src 에서 RED). stdout 은 wire(AgentMessage) 전용 — 로그는 stderr.
//
// 순수 유지: write/now/debug 게이트는 **주입**(entry 가 process.stderr + NAIA_AGENT_DEBUG 제공, 테스트는 버퍼).
// 형식 = `[ISO ts] [LEVEL] [agent] message {ctx}`. debug() 는 디버그 모드에서만(진입·분기 로깅 P1, 릴리즈 생략).
import type { DiagnosticLog } from "../ports/uc1.js";

export interface DiagnosticOpts {
	/** 한 줄 출력(개행 미포함 줄). 기본 미주입 시 no-op(코어 순수). entry 가 process.stderr 주입. */
	write?: (line: string) => void;
	/** 진입·분기 debug 로그 출력 여부. 기본 false(릴리즈). entry 가 NAIA_AGENT_DEBUG===1 주입. */
	debug?: boolean;
	/** timestamp 생성기(기본 ISO now). 테스트 주입. */
	now?: () => string;
	/** 컴포넌트 라벨(기본 "agent"). */
	component?: string;
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

/** 표준 DiagnosticLog sink. write 미주입=no-op(테스트/헤드리스 무소음). entry 가 stderr+debug 게이트 주입. */
export function makeStderrDiagnostic(opts: DiagnosticOpts = {}): DiagnosticLog {
	const write = opts.write;
	const debugOn = opts.debug ?? false;
	const now = opts.now ?? (() => new Date().toISOString());
	const comp = opts.component ?? "agent";
	const fmt = (level: string, message: string, ctx?: unknown) =>
		`[${now()}] [${level}] [${comp}] ${message}${ctx !== undefined ? ` ${safeJson(ctx)}` : ""}`;
	return {
		log: (message, ctx) => write?.(fmt("INFO", message, ctx)),
		debug: (message, ctx) => {
			if (debugOn) write?.(fmt("DEBUG", message, ctx));
		},
	};
}
