/**
 * provider-resolver — UC12 런타임 provider 선택 (순수).
 *
 * 기존 컨벤션 재사용(새 스킴 금지): naia-os 의 buildNaiaConfigEnv 가
 * `{adkPath}/naia-settings/config.json` 에 쓰는 필드를 그대로 읽는다.
 *   NAIA_MAIN_PROVIDER (nextain→"naia") · NAIA_MAIN_MODEL · OPENAI_BASE_URL ·
 *   NAIA_ANYLLM_BASE_URL
 * 비밀키는 config.json 에 없으므로(보안) env(키체인 주입)에서 읽는다:
 *   GLM_KEY/GLM_API_KEY · OPENAI_API_KEY · NAIA_ANYLLM_API_KEY
 *
 * 선택 우선순위: (1) config.json 의 NAIA_MAIN_PROVIDER → (2) AGENT_PROVIDER env
 * (dev 스크립트/헤드리스) → (3) fake. 이렇게 run-new-core-dev.sh(AGENT_PROVIDER)
 * 와 앱 런타임(naia-settings 영속) 둘 다 동작.
 *
 * 순수: fs/네트워크 없음. 엔트리가 config.json 을 읽어 객체로 넘기고, 반환된
 * spec 으로 어댑터를 만든다(테스트는 spec 만 검증 — 직교 앵커).
 */

export type ProviderSpec =
	| { kind: "ollama"; model?: string; label: string }
	| { kind: "openai-compat"; baseUrl: string; apiKey: string; model?: string; label: string }
	| { kind: "fake"; reason: string; label: string };

const GLM_CODING_DEFAULT = "https://api.z.ai/api/coding/paas/v4";

/** config.json 의 NAIA_MAIN_PROVIDER("naia") 와 AGENT_PROVIDER env("glm") 를 정규화. */
function normalizeProvider(raw: string | undefined): string | null {
	if (!raw) return null;
	const v = raw.trim().toLowerCase();
	if (!v) return null;
	if (v === "nextain") return "naia";
	return v;
}

/**
 * @param input.config  naia-settings/config.json 파싱 객체(없으면 {})
 * @param input.env     process.env (키 + AGENT_PROVIDER 폴백)
 */
export function resolveProviderSpec(input: {
	config: Record<string, unknown>;
	env: Record<string, string | undefined>;
}): ProviderSpec {
	const { config, env } = input;
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() ? v.trim() : undefined;

	// (1) config.json 우선, (2) AGENT_PROVIDER env 폴백.
	const provider =
		normalizeProvider(str(config.NAIA_MAIN_PROVIDER)) ?? normalizeProvider(env.AGENT_PROVIDER);
	const model = str(config.NAIA_MAIN_MODEL) ?? undefined;

	switch (provider) {
		case "ollama":
			// host 는 per-request ProviderConfig(config.ollamaHost)로 전달되므로 여기선 종류만.
			return { kind: "ollama", model, label: "ollama" };

		case "glm": {
			// GLM 은 UI model(naia-local 등)을 거부하므로 유효 모델 강제(기존 동작).
			const glmModel = str(env.GLM_MODEL) ?? (model && /^glm/i.test(model) ? model : undefined) ?? "glm-4.6";
			const baseUrl = str(env.GLM_BASE_URL) ?? GLM_CODING_DEFAULT;
			const apiKey = env.GLM_KEY || env.GLM_API_KEY || "";
			return { kind: "openai-compat", baseUrl, apiKey, model: glmModel, label: `glm(z.ai ${glmModel})` };
		}

		case "vllm": {
			const baseUrl = str(config.OPENAI_BASE_URL);
			if (!baseUrl) return { kind: "fake", reason: "vllm 선택인데 OPENAI_BASE_URL 미설정", label: "fake" };
			return { kind: "openai-compat", baseUrl, apiKey: "", model, label: `vllm(${model ?? "?"})` };
		}

		case "openai": {
			const baseUrl = str(config.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
			return { kind: "openai-compat", baseUrl, apiKey: env.OPENAI_API_KEY || "", model, label: `openai(${model ?? "?"})` };
		}

		case "naia": {
			const baseUrl = str(config.NAIA_ANYLLM_BASE_URL);
			if (!baseUrl) return { kind: "fake", reason: "naia 선택인데 NAIA_ANYLLM_BASE_URL 미설정", label: "fake" };
			return { kind: "openai-compat", baseUrl, apiKey: env.NAIA_ANYLLM_API_KEY || "", model, label: `naia(${model ?? "?"})` };
		}

		case null:
			return { kind: "fake", reason: "provider 미선택(config.json 없음 + AGENT_PROVIDER 미설정)", label: "fake" };

		default:
			return { kind: "fake", reason: `미지원 provider: ${provider}`, label: "fake" };
	}
}
