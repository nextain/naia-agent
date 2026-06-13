// adapters/naia-settings-store — config 정본 = `<adkPath>/naia-settings/` (= naia-adk 워크스페이스, 루크 정본).
//
// naia-os 셸이 기동/저장 시 **config.json** 을 거기에 쓴다(`writeNaiaConfig` → stripForAgent: provider/model 포함,
// 시크릿은 strip 되어 OS 키체인으로). agent 는 기동 시 그 config 를 로딩해 활성 provider 를 구성한다(정본:
// "대화는 메시지만 — agent 가 미리 설정된 provider 로 처리"). **키는 config 에 없음** — chat 시 keychain
// CredentialPort(`credentials.get(provider)`)가 공급하므로 store 는 {provider, model}(+host override)만 읽는다.
//
// 읽기 우선순위(old naia-agent loader 와 정합): (1) `llm.json`(구 CLI login 의 3-role {main} 포맷, apiKeyRef →
// 주입 resolveSecret) (2) `config.json`(naia-os 셸 정본 포맷). (1)이 stale/부재면 (2)로 폴백.
//
// 헥사고날: 전역 env 변이 없이 ProviderConfig 반환. fs read 주입(node:fs 직접 import 금지). 평문키 방어(llm.json).
import type { ProviderConfig } from "../domain/chat.js";
import { resolveProviderRoute } from "../domain/provider-route.js";

/** llm.json/config.json 읽기용 최소 fs. node:fs 를 entry 가 주입, 테스트는 fake. */
export interface SettingsFsRead {
	existsSync(path: string): boolean;
	readFileSync(path: string, encoding: "utf8"): string;
}

/** apiKeyRef(env 이름 또는 키체인 엔트리명) → 비밀값. old resolveSecret 거울(llm.json 경로 전용). */
export type ResolveSecret = (ref: string) => string | undefined;

interface LLMRole {
	provider?: string;
	baseUrl?: string;
	model?: string;
	apiKeyRef?: string;
}
interface LLMSettings {
	version?: number;
	main?: LLMRole;
	sub?: LLMRole;
	embedded?: LLMRole;
}

// 평문 키 금지 불변식 방어(old naia-settings.ts 이식) — git-tracked llm.json 에 raw 자격증명 유입 차단.
const SECRETISH_KEY = /^(api[_-]?key|key|token|secret|password|passwd|pwd|bearer)$/i;
const RAW_SECRET_VALUE = [
	/sk-[A-Za-z0-9_-]{8,}/, // incl. Anthropic sk-ant-api03-…
	/AIza[0-9A-Za-z_-]{10,}/,
	/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9]/,
	/xox[baprs]-[A-Za-z0-9]/,
	/\bAKIA[0-9A-Z]{12,}/,
	/^[0-9a-f]{40,}$/i,
];
/** role 객체에 평문-비밀 의심 키/값이 있으면 true(llm.json 파일 거부 트리거). */
export function roleHasPlaintextSecret(role: unknown): boolean {
	if (!role || typeof role !== "object") return false;
	for (const [k, v] of Object.entries(role as Record<string, unknown>)) {
		if (k.toLowerCase() !== "apikeyref" && SECRETISH_KEY.test(k)) return true;
		if (typeof v === "string" && RAW_SECRET_VALUE.some((re) => re.test(v))) return true;
	}
	return false;
}

export interface NaiaSettingsStore {
	/** `<adkPath>/naia-settings/` 의 활성 ProviderConfig(llm.json main → config.json 순). 없음/손상 = null(degrade, no-throw). */
	loadMain(adkPath: string): ProviderConfig | null;
}

const KNOWN_VERSION = 1;

/** provider/model + 라우팅별 host override → ProviderConfig 조립(키는 미포함 — credentials 포트가 chat 시 공급).
 *  단, llm.json 경로는 apiKeyRef 해석 비밀을 옵션으로 실어줄 수 있음(secret). */
function assembleConfig(
	provider: string,
	model: string,
	opts: { secret?: string; baseUrl?: string; ollamaHost?: string; vllmHost?: string },
): ProviderConfig {
	const base = { provider, model };
	const route = resolveProviderRoute(base);
	if (route === "lab-proxy") {
		return { ...base, ...(opts.secret ? { naiaKey: opts.secret } : {}), ...(opts.baseUrl ? { labGatewayUrl: opts.baseUrl } : {}) };
	}
	if (route === "ollama") {
		return { ...base, ...(opts.ollamaHost ?? opts.baseUrl ? { ollamaHost: opts.ollamaHost ?? opts.baseUrl } : {}) };
	}
	// native 직결 — 키는 credentials 포트(키체인)가 공급. llm.json apiKeyRef 가 있으면 그 secret 도 채움.
	return { ...base, ...(opts.secret ? { apiKey: opts.secret } : {}), ...(provider === "vllm" && (opts.vllmHost ?? opts.baseUrl) ? { vllmHost: opts.vllmHost ?? opts.baseUrl } : {}) };
}

export function makeNaiaSettingsStore(deps: {
	fs: SettingsFsRead;
	resolveSecret: ResolveSecret;
	log?: (message: string, ctx?: unknown) => void;
}): NaiaSettingsStore {
	const { fs, resolveSecret } = deps;
	const log = deps.log ?? (() => {});

	function readJson<T>(file: string): T | null {
		try {
			if (!fs.existsSync(file)) return null;
			return JSON.parse(fs.readFileSync(file, "utf8")) as T;
		} catch {
			log("naia-settings.read.error", { file });
			return null;
		}
	}

	/** (1) 구 CLI login 포맷 llm.json {version, main:{provider, model, baseUrl, apiKeyRef}}. apiKeyRef → resolveSecret. */
	function fromLlmJson(file: string): ProviderConfig | null {
		const parsed = readJson<LLMSettings>(file);
		if (!parsed || typeof parsed !== "object" || !parsed.main) return null; // 부재/shape 불일치(stale {openai:..} 포함) = 폴백
		if (parsed.version !== undefined && parsed.version !== KNOWN_VERSION) log("naia-settings.version.unknown", { file, version: parsed.version });
		if (roleHasPlaintextSecret(parsed.main)) { log("naia-settings.secret.plaintext_suspected", { file, role: "main" }); return null; }
		const m = parsed.main;
		const provider = (m.provider ?? "").toLowerCase();
		const model = m.model ?? "";
		if (!provider || !model) { log("naia-settings.main.incomplete", { file }); return null; }
		const secret = m.apiKeyRef ? resolveSecret(m.apiKeyRef) : undefined;
		return assembleConfig(provider, model, { ...(secret ? { secret } : {}), ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}) });
	}

	/** (2) naia-os 셸 정본 포맷 config.json {provider, model, ollamaHost, vllmHost, naiaGatewayUrl/NAIA_ANYLLM_BASE_URL}.
	 *  키는 여기 없음(셸이 strip → 키체인) — credentials 포트가 chat 시 공급. */
	function fromConfigJson(file: string): ProviderConfig | null {
		const c = readJson<Record<string, unknown>>(file);
		if (!c || typeof c !== "object") return null;
		const provider = typeof c["provider"] === "string" ? (c["provider"] as string).toLowerCase() : "";
		const model = typeof c["model"] === "string" ? (c["model"] as string) : "";
		if (!provider || !model) { log("naia-settings.config.incomplete", { file }); return null; }
		const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined);
		const baseUrl = str("naiaGatewayUrl") ?? str("NAIA_ANYLLM_BASE_URL");
		return assembleConfig(provider, model, {
			...(baseUrl ? { baseUrl } : {}),
			...(str("ollamaHost") ? { ollamaHost: str("ollamaHost")! } : {}),
			...(str("vllmHost") ? { vllmHost: str("vllmHost")! } : {}),
		});
	}

	return {
		loadMain(adkPath) {
			if (!adkPath) return null;
			const dir = `${adkPath.replace(/\/+$/, "")}/naia-settings`;
			return fromLlmJson(`${dir}/llm.json`) ?? fromConfigJson(`${dir}/config.json`);
		},
	};
}
