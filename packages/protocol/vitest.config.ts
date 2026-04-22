import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
			thresholds: {
				lines: 85,
				branches: 85,
				functions: 85,
				statements: 85,
			},
		},
	},
});
