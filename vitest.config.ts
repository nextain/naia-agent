import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Scope to the TypeScript vitest suites only. The `*.test.mjs` files under
		// src/test/ are node:test harness self-trust tests run via `node --test`,
		// not vitest. Using a config `include` (instead of a CLI glob in the npm
		// script) makes `pnpm test` work the same on Windows and POSIX — a bare CLI
		// glob like `src/test/*.test.ts` is not shell-expanded on Windows and yields
		// "No test files found".
		include: ["src/test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
	},
});
