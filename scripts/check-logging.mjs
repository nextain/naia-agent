#!/usr/bin/env node
// check-logging — 로깅 표준 강제(docs/logging.md, 계약 F-LOG-3). "표준만, 다른 방식 금지"를 결정론으로 차단.
//
// 규칙: src/ 의 모든 .ts 는 표준 로깅 경로만 쓴다 — 코어/앱/어댑터는 `DiagnosticLog` 포트로 로깅하고,
// 실제 sink 는 `adapters/diagnostic.ts`(유일). 따라서 src 안에서 `console.*` 와 직접 `process.stdout/stderr.write`
// 는 금지(= 다른 로깅 방식). 발견 시 RED → 표준(DiagnosticLog/Logger.debug)으로 교정.
//   - stdout 직접 쓰기는 wire(AgentMessage) 전용 어댑터(stdio.ts)만 허용(allow-list).
//   - 테스트(__tests__/*.test.ts)는 제외.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

// 직접 sink/transport 라 console·process write 가 허용되는 경계 파일(표준 그 자체).
const ALLOW = new Set([
	"src/main/adapters/stdio.ts", // wire transport — stdout/stderr 라인 IO 가 본분
]);

const FORBIDDEN = [
	{ re: /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/, msg: "console.* 직접 사용 — 표준 DiagnosticLog(diag.log/diag.debug) 사용" },
	{ re: /\bprocess\.(stdout|stderr)\.write\s*\(/, msg: "process.stdout/stderr.write 직접 사용 — DiagnosticLog sink(adapters/diagnostic.ts) 경유" },
];

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

const violations = [];
for (const file of walk(SRC)) {
	const rel = relative(ROOT, file);
	if (rel.includes("__tests__") || rel.endsWith(".test.ts") || ALLOW.has(rel)) continue;
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return; // 주석 제외
		for (const f of FORBIDDEN) {
			if (f.re.test(line)) violations.push(`  ✗ ${rel}:${i + 1} — ${f.msg}`);
		}
	});
}

if (violations.length) {
	console.error(`[check-logging] RED — 표준 외 로깅 ${violations.length}건 (docs/logging.md · 계약 F-LOG-3):`);
	console.error(violations.join("\n"));
	process.exit(1);
}
console.error("[check-logging] OK — src 전부 표준 로깅(DiagnosticLog). console.*/직접 write 0건.");
