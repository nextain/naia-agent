import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["src/skill-loader.ts"],
			// Phase A.2 scope: skill-loader parseSkillManifest + helpers only.
			// Other runtime files (tool-executor, mcp, etc.) covered in later phases.
			thresholds: {
				lines: 80,
				branches: 75,
				functions: 80,
				statements: 80,
			},
		},
	},
});
