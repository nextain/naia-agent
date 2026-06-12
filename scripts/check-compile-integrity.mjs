#!/usr/bin/env node
/**
 * check-compile-integrity (new-naia-agent) — 컴파일 무결성 게이트.
 * Luke 2026-06-12 "항상 깨끗한 상태 유지". 깨진 상태(삭제된 파일 import 등 = tsc 에러)를
 * 어떤 검출기도 tsc 를 안 돌려 미감지였던 갭 차단. pre-commit + cron(verify-watch) 공용.
 * 검사: agent src tsc(테스트-타입 노이즈 제외). exit 1 = src 컴파일 깨짐(RED).
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
	execSync("npx tsc -p tsconfig.json --noEmit", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	console.log("[compile-integrity] ✅ PASS — agent src 컴파일 무결.");
	process.exit(0);
} catch (e) {
	const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
	const srcErrs = out.split("\n").filter((l) => /error TS\d+/.test(l) && !/__tests__|\.test\.|\.spec\./.test(l));
	if (!srcErrs.length) {
		console.log("[compile-integrity] ✅ PASS — agent src 컴파일 무결(테스트-타입 노이즈만).");
		process.exit(0);
	}
	console.error(`[compile-integrity] ❌ RED — agent src 컴파일 위반 ${srcErrs.length}건(깨진/불완전 상태):`);
	for (const l of srcErrs) console.error("  " + l);
	process.exit(1);
}
