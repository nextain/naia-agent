// adapters/naia-settings-store — config 정본 = `<adkPath>/naia-settings/` (= naia-adk 워크스페이스, 루크 정본).
//
// naia-os 셸이 기동/저장 시 **config.json** 을 거기에 쓴다(`writeNaiaConfig` → stripForAgent: provider/model 포함,
// 시크릿은 strip 되어 OS 키체인으로). agent 는 기동 시 그 config 를 로딩해 활성 provider 를 구성한다(정본:
// "대화는 메시지만 — agent 가 미리 설정된 provider 로 처리"). **키는 config 에 없음** — chat 시 keychain
// CredentialPort(`credentials.get(provider)`)가 공급하므로 store 는 {provider, model}(+host override)만 읽는다.
//
// 읽기 우선순위(2026-06-17 정정 — desktop SoT 우선): (1) `config.json`(naia-os 셸 정본 — UI 선택을 OS 가 기록,
// 라이브 reload 의 권위) (2) `llm.json`(구 CLI login 의 3-role {main} 포맷, apiKeyRef → 주입 resolveSecret) 폴백.
// (구 순서는 llm.json 우선이었으나 stale llm.json 이 config.json 을 덮어 채팅 throw 시키는 회귀가 있어 역전.)
//
// 헥사고날: 전역 env 변이 없이 ProviderConfig 반환. fs read 주입(node:fs 직접 import 금지). 평문키 방어(llm.json).
import type { ProviderConfig } from "../domain/chat.js";
import { resolveProviderRoute } from "../domain/provider-route.js";
import {
	resolveLlmRoles,
	type LlmRoleSelection,
	type LlmRolesResolution,
} from "../domain/llm-roles.js";

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

/** config.json 의 메모리 런타임 설정(issue #7) — os 메모리 UI 가 write_naia_config 로 기록한 adapter/embedding
 *  선택. 비밀(*ApiKey/naiaKey)은 셸이 strip 하므로 config.json 엔 없음 → resolveSecret(env/키체인)로 best-effort.
 *  makeNaiaMemory 의 NaiaMemoryOpts(adapter·qdrant·embedding)와 동형(entry 가 그대로 전달). */
export interface MemoryRuntimeConfig {
	adapter: "local" | "qdrant";
	qdrantUrl?: string;
	qdrantApiKey?: string;
	embedding: {
		provider: "none" | "offline" | "vllm" | "ollama" | "naia";
		offlineModel?:
			| "all-MiniLM-L6-v2"
			| "all-mpnet-base-v2"
			| "multilingual-e5-large"
			| "paraphrase-multilingual-MiniLM-L12-v2";
		/** naia-embedded 컴퓨트 device(provider="offline"). cpu/gpu/auto. */
		device?: "cpu" | "gpu" | "auto";
		baseUrl?: string;
		apiKey?: string;
		model?: string;
		naiaGatewayUrl?: string;
		naiaKey?: string;
	};
	/** LLM 사실추출(factExtractor). naia=게이트웨이, vllm/ollama=로컬. provider/baseUrl/model 정규화됨. */
	llm: {
		provider: "none" | "vllm" | "ollama" | "naia";
		baseUrl?: string;
		apiKey?: string;
		model?: string;
	};
}

// EngineProfileMode(3-profile 잔재 "naia"|"direct"|"local")은 Phase 3.3 으로 폐기.
// gate(naiaKey 파생)는 naia-os 측 소유(config.json 의 naiaKey 는 strip → agent 가 gate 산출 불가).
// 여기서는 3-role 스냅샷만 제공(mode 파생 제거). SoT = alpha-adk 플랜 naia-model-slots-architecture.
export type LocalGpuTier =
	| "off"
	| "auto"
	| "external-llm-6g"
	| "avatar-voice-12g"
	| "full-local-24g";

export interface EngineProfileConfig {
	mainProvider: string;
	mainModel: string;
	subProvider: "none" | "naia" | "vllm" | "ollama";
	embeddingProvider: "none" | "offline" | "vllm" | "ollama" | "naia";
	localGpuTier: LocalGpuTier;
}

export interface NaiaSettingsStore {
	/** `<adkPath>/naia-settings/` 의 활성 ProviderConfig(llm.json main → config.json 순). 없음/손상 = null(degrade, no-throw). */
	loadMain(adkPath: string): ProviderConfig | null;
	/** config.json 의 메모리 adapter/embedding 선택(issue #7). 부재/손상/미설정 = null(메모리 기본=local+키워드-only). */
	loadMemoryConfig(adkPath: string): MemoryRuntimeConfig | null;
	loadEngineProfile(adkPath: string): EngineProfileConfig | null;
	/** 구조화 llmRoles + legacy 필드를 main/sub/memory effective config/provenance로 해석한다. */
	loadLlmRoles(adkPath: string): LlmRolesResolution | null;
}

const KNOWN_VERSION = 1;

// naia 게이트웨이 sub-LLM(메모리 사실추출/요약) 기본 모델 — config 의 memoryLlmModel 부재 시 폴백.
// naia-os SettingsTab 은 provider="naia" 일 때 model 입력란을 렌더하지 않아(vllm/ollama 만) memoryLlmModel 을
// 비워두므로(실측), 기본이 없으면 baseUrl 만 있고 model 누락 → makeNaiaMemory 의 fail-closed throw 로 메모리 전체가
// OFF 가 된다(G5). FR-SLOT.3(naia 계정=sub-LLM gemini-flash-lite 기본)에 맞춘 경량 게이트웨이 모델.
// ⚠️ 모델 *문자열*(시크릿 아님). main 모델(NAIA_MAIN_MODEL)은 게이트웨이가 아닐 수 있어(예: anthropic 직결) 부적합.
const NAIA_MEMORY_LLM_DEFAULT_MODEL = "gemini-3.1-flash-lite";

/** provider/model + 라우팅별 host override → ProviderConfig 조립(키는 미포함 — credentials 포트가 chat 시 공급).
 *  단, llm.json 경로는 apiKeyRef 해석 비밀을 옵션으로 실어줄 수 있음(secret). */
function assembleConfig(
	provider: string,
	model: string,
	opts: { secret?: string; baseUrl?: string; ollamaHost?: string; ollamaNumGpu?: number; vllmHost?: string },
): ProviderConfig {
	const base = { provider, model };
	const route = resolveProviderRoute(base);
	if (route === "lab-proxy") {
		return { ...base, ...(opts.secret ? { naiaKey: opts.secret } : {}), ...(opts.baseUrl ? { labGatewayUrl: opts.baseUrl } : {}) };
	}
	if (route === "ollama") {
		return {
			...base,
			...(opts.ollamaHost ?? opts.baseUrl ? { ollamaHost: opts.ollamaHost ?? opts.baseUrl } : {}),
			...(opts.ollamaNumGpu !== undefined ? { ollamaNumGpu: opts.ollamaNumGpu } : {}),
		};
	}
	if (route === "anthropic") {
		// Messages API(anthropic) — 키는 credentials 포트(키체인 ANTHROPIC_API_KEY)가 chat 시 공급.
		// llm.json apiKeyRef secret/baseUrl override 도 보존(host override=labGatewayUrl, 어댑터가 anthropicBaseUrl 로 소비).
		return { ...base, ...(opts.secret ? { apiKey: opts.secret } : {}), ...(opts.baseUrl ? { labGatewayUrl: opts.baseUrl } : {}) };
	}
	if (route === "claude-code") {
		// claude-code-cli — Claude Agent SDK(로컬 구독 인증). 키·baseUrl 불요(SDK 가 CLI 프로세스로 인증/전송).
		// ⚠️ secret/baseUrl 을 실으면 안 됨 — apiKey 가 있으면 구독 아닌 직접 키 과금 패러다임으로 오해될 수 있음. {provider,model}만.
		return { ...base };
	}
	if (route === "codex") {
		// codex — 로컬 app-server가 Codex 로그인을 사용. token/apiKey/baseUrl은 설정에 복사하지 않는다.
		return { ...base };
	}
	// native 직결 — 키는 credentials 포트(키체인)가 공급. llm.json apiKeyRef 가 있으면 그 secret 도 채움.
	// ⚠️ host override 보존: vllm=vllmHost, 그 외 native=labGatewayUrl(provider-resolver 가 nativeBaseUrl(provider,
	//    config.labGatewayUrl) 로 전달하는 override 필드). 안 실으면 커스텀 endpoint(openai-compat/self-host)가
	//    nativeBaseUrl default 에서 "baseUrl 미정의" throw → 채팅 전체가 죽는다(실측 회귀). baseUrl 있으면 항상 보존.
	return {
		...base,
		...(opts.secret ? { apiKey: opts.secret } : {}),
		...(provider === "vllm"
			? (opts.vllmHost ?? opts.baseUrl ? { vllmHost: opts.vllmHost ?? opts.baseUrl } : {})
			: (opts.baseUrl ? { labGatewayUrl: opts.baseUrl } : {})),
	};
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
		const nonNegativeInt = (k: string) =>
			typeof c[k] === "number" && Number.isInteger(c[k]) && c[k] >= 0
				? (c[k] as number)
				: undefined;
		// ⚠️ naiaGatewayUrl/NAIA_ANYLLM_BASE_URL = nextain(lab-proxy 게이트웨이) **전용** 필드. native provider(openai/
		//    gemini/xai/zai 등)엔 적용하면 안 됨 — config 에 stale naiaGatewayUrl 이 남은 채 provider 를 native 로 바꾸면
		//    그 native 호출이 stale 게이트웨이로 **조용히 오라우팅**(적대적 리뷰 MEDIUM). native 커스텀 host=vllmHost/
		//    ollamaHost 전용 필드 또는 llm.json baseUrl(CLI). nextain 이 아니면 baseUrl 미적용.
		const baseUrl = provider === "nextain" ? (str("naiaGatewayUrl") ?? str("NAIA_ANYLLM_BASE_URL")) : undefined;
		return assembleConfig(provider, model, {
			...(baseUrl ? { baseUrl } : {}),
			...(str("ollamaHost") ? { ollamaHost: str("ollamaHost")! } : {}),
			...(nonNegativeInt("ollamaNumGpu") !== undefined
				? { ollamaNumGpu: nonNegativeInt("ollamaNumGpu")! }
				: {}),
			...(str("vllmHost") ? { vllmHost: str("vllmHost")! } : {}),
		});
	}

	function fromConfigJsonEngineProfile(file: string): EngineProfileConfig | null {
		const c = readJson<Record<string, unknown>>(file);
		if (!c || typeof c !== "object") return null;
		const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined);
		const provider = str("provider")?.toLowerCase() ?? "";
		const model = str("model") ?? "";
		if (!provider || !model) {
			log("naia-settings.engine_profile.incomplete", { file });
			return null;
		}
		const subProvider = (["naia", "vllm", "ollama"] as const).find((p) => p === str("memoryLlmProvider")) ?? "none";
		const embeddingProvider =
			(["offline", "vllm", "ollama", "naia"] as const).find((p) => p === str("memoryEmbeddingProvider")) ?? "none";
		const localGpuTier =
			(["off", "auto", "external-llm-6g", "avatar-voice-12g", "full-local-24g"] as const).find(
				(tier) => tier === str("localGpuTier"),
			) ?? "off";
		// mode(3-profile 파생 "naia"|"direct"|"local")은 Phase 3.3 폐기 — gate 는 naia-os 측(naiaKey).
		return {
			mainProvider: provider,
			mainModel: model,
			subProvider,
			embeddingProvider,
			localGpuTier,
		};
	}

	function roleSelection(value: unknown): LlmRoleSelection | undefined {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		if (roleHasPlaintextSecret(value)) return undefined;
		const role = value as Record<string, unknown>;
		const str = (key: string) => typeof role[key] === "string" ? (role[key] as string) : undefined;
		const inherit = (["main", "sub", "memory"] as const).find((candidate) => candidate === str("inherit"));
		const selection: LlmRoleSelection = {
			...(str("provider") ? { provider: str("provider") } : {}),
			...(str("model") ? { model: str("model") } : {}),
			...(str("baseUrl") ? { baseUrl: str("baseUrl") } : {}),
			...(str("credentialRef") ? { credentialRef: str("credentialRef") } : {}),
			...(inherit ? { inherit } : {}),
		};
		return Object.keys(selection).length ? selection : undefined;
	}

	function fromConfigJsonLlmRoles(file: string): LlmRolesResolution | null {
		const c = readJson<Record<string, unknown>>(file);
		if (!c || typeof c !== "object") return null;
		const str = (key: string) => typeof c[key] === "string" ? (c[key] as string) : undefined;
		const structured = c["llmRoles"] && typeof c["llmRoles"] === "object" && !Array.isArray(c["llmRoles"])
			? c["llmRoles"] as Record<string, unknown>
			: undefined;
		const mainRole = roleSelection(structured?.["main"]);
		const subRole = roleSelection(structured?.["sub"]);
		const memoryRole = roleSelection(structured?.["memory"]);
		const roles = {
			...(mainRole ? { main: mainRole } : {}),
			...(subRole ? { sub: subRole } : {}),
			...(memoryRole ? { memory: memoryRole } : {}),
		};
		const providerSelection = (prefix: "" | "subLlm" | "memoryLlm"): LlmRoleSelection | undefined => {
			const provider = str(prefix ? `${prefix}Provider` : "provider");
			const model = str(prefix ? `${prefix}Model` : "model");
			if (!provider || provider === "none") return undefined;
			const baseUrl = prefix ? str(`${prefix}BaseUrl`) : undefined;
			const credentialRef = prefix ? str(`${prefix}CredentialRef`) : undefined;
			return {
				provider,
				...(model ? { model } : {}),
				...(baseUrl ? { baseUrl } : {}),
				...(credentialRef ? { credentialRef } : {}),
			};
		};
		const legacyMain = providerSelection("");
		const legacySub = providerSelection("subLlm");
		const legacyMemory = providerSelection("memoryLlm");
		const legacy = {
			...(legacyMain ? { main: legacyMain } : {}),
			...(legacySub ? { sub: legacySub } : {}),
			...(legacyMemory ? { memory: legacyMemory } : {}),
		};
		if (!Object.keys(roles).length && !Object.keys(legacy).length) return null;
		return resolveLlmRoles({ roles, legacy });
	}

	function fromLlmJsonLlmRoles(file: string): LlmRolesResolution | null {
		const parsed = readJson<LLMSettings>(file);
		if (!parsed || typeof parsed !== "object") return null;
		for (const role of [parsed.main, parsed.sub, parsed.embedded]) {
			if (roleHasPlaintextSecret(role)) {
				log("naia-settings.secret.plaintext_suspected", { file, role: "llmRoles" });
				return null;
			}
		}
		const main = roleSelection(parsed.main);
		const sub = roleSelection(parsed.sub);
		const memory = roleSelection(parsed.embedded);
		if (!main && !sub && !memory) return null;
		return resolveLlmRoles({
			roles: {
				...(main ? { main } : {}),
				...(sub ? { sub } : {}),
				...(memory ? { memory } : {}),
			},
		});
	}

	/** (issue #7) config.json → MemoryRuntimeConfig. 비밀(*ApiKey/naiaKey)은 strip 되므로 env/키체인(resolveSecret)
	 *  best-effort(로컬 서버=빈 값 허용). 부재/손상 = null(메모리 기본 local+키워드-only). */
	function fromConfigJsonMemory(file: string): MemoryRuntimeConfig | null {
		const c = readJson<Record<string, unknown>>(file);
		if (!c || typeof c !== "object") return null;
		const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined);
		const adapter = str("memoryAdapter") === "qdrant" ? "qdrant" : "local";
		const ep = str("memoryEmbeddingProvider");
		const provider = (["offline", "vllm", "ollama", "naia"] as const).find((p) => p === ep) ?? "none";
		const om = str("memoryOfflineModel");
		const offlineModel = (["all-MiniLM-L6-v2", "all-mpnet-base-v2", "multilingual-e5-large", "paraphrase-multilingual-MiniLM-L12-v2"] as const).find((m) => m === om);
		const dev = str("memoryEmbeddingDevice");
		const device = (["cpu", "gpu", "auto"] as const).find((d) => d === dev);
		const embedApiKey = resolveSecret("NAIA_MEMORY_EMBED_API_KEY");
		const qdrantApiKey = resolveSecret("NAIA_MEMORY_QDRANT_API_KEY");
		// naiaKey 는 os writeAgentKey(naiaKey)가 키체인 account "NAIA_ANYLLM_API_KEY" 로 기록(resolveAgentEnvKey).
		// 메모리 naia 임베딩/LLM 도 같은 게이트웨이 키를 쓴다. 구 ref(NAIA_KEY/naiaKey)는 env override 폴백으로 유지.
		const naiaKey =
			resolveSecret("NAIA_ANYLLM_API_KEY") ??
			resolveSecret("NAIA_KEY") ??
			resolveSecret("naiaKey");
		// naia 게이트웨이 URL — main provider(provider-route labProxyBaseUrl)와 동일 해석: config(naiaGatewayUrl ??
		// NAIA_ANYLLM_BASE_URL) 우선, 둘 다 없으면 기본 api.nextain.io. ⚠️ OS 는 config 에 naiaGatewayUrl 을 직접
		// 안 쓰므로(있어도 NAIA_ANYLLM_BASE_URL 형태), 기본값 없으면 naia 임베딩/LLM 이 조용히 키워드-only 로 죽는다(적대적 리뷰 HIGH 수정).
		const naiaGatewayUrl =
			str("naiaGatewayUrl") ??
			str("NAIA_ANYLLM_BASE_URL") ??
			"https://api.nextain.io";
		// LLM 사실추출(factExtractor) — naia=게이트웨이(naiaGatewayUrl+naiaKey), vllm/ollama=memoryLlmBaseUrl+로컬키.
		const lp = str("memoryLlmProvider");
		const selectedLlmProvider = (["vllm", "ollama", "naia"] as const).find((p) => p === lp) ?? "none";
		// naia: baseUrl=게이트웨이(항상 해석), model=memoryLlmModel ?? 기본 게이트웨이 경량 모델(S5: OS 가 naia 일 때
		//   model 을 안 써 누락 → 기본 없으면 makeNaiaMemory throw 로 메모리 전체 OFF). key=naiaKey(게이트웨이 호출 필수).
		// vllm/ollama: baseUrl/model=config, key=로컬(보통 빈 값 허용).
		const llmBaseUrl = selectedLlmProvider === "naia" ? naiaGatewayUrl : str("memoryLlmBaseUrl");
		const llmKey = selectedLlmProvider === "naia" ? naiaKey : resolveSecret("NAIA_MEMORY_LLM_API_KEY");
		const llmModel =
			str("memoryLlmModel") ?? (selectedLlmProvider === "naia" ? NAIA_MEMORY_LLM_DEFAULT_MODEL : undefined);
		// graceful degrade(S5): sub-LLM 을 깨끗이 구성할 수 없으면(baseUrl/model 누락, 또는 naia 인데 키 부재로
		//   게이트웨이 호출 불가) provider 를 "none" 으로 강등 → buildSubLlmProvider/buildMemoryFactExtractor 가
		//   undefined(휴리스틱) 반환 → 메모리는 embedding/키워드로 **계속 동작**(LLM 추출/요약만 생략). sub-LLM 부재가
		//   메모리 전체를 죽이지 않게 한다(이전엔 model 누락이 fail-closed throw → memory=off).
		const llmConfigurable =
			selectedLlmProvider !== "none" &&
			!!llmBaseUrl?.trim() &&
			!!llmModel?.trim() &&
			(selectedLlmProvider !== "naia" || !!llmKey?.trim());
		const llmProvider = llmConfigurable ? selectedLlmProvider : "none";
		return {
			adapter,
			...(str("qdrantUrl") ? { qdrantUrl: str("qdrantUrl") } : {}),
			...(qdrantApiKey ? { qdrantApiKey } : {}),
			embedding: {
				provider,
				...(offlineModel ? { offlineModel } : {}),
				...(device ? { device } : {}),
				...(str("memoryEmbeddingBaseUrl") ? { baseUrl: str("memoryEmbeddingBaseUrl") } : {}),
				...(embedApiKey ? { apiKey: embedApiKey } : {}),
				...(str("memoryEmbeddingModel") ? { model: str("memoryEmbeddingModel") } : {}),
				naiaGatewayUrl, // config 우선 + 기본 api.nextain.io 폴백(naia 임베딩이 게이트웨이를 항상 찾도록).
				...(naiaKey ? { naiaKey } : {}),
			},
			llm:
				llmProvider === "none"
					? { provider: "none" }
					: {
							provider: llmProvider,
							...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}),
							...(llmKey ? { apiKey: llmKey } : {}),
							...(llmModel ? { model: llmModel } : {}),
						},
		};
	}

	return {
		loadMain(adkPath) {
			if (!adkPath) return null;
			const dir = `${adkPath.replace(/\/+$/, "")}/naia-settings`;
			// ⚠️ precedence: config.json(naia-os 셸 정본 — 사용자가 UI 에서 고른 provider/model 을 OS 가 write_naia_config 로
		//    기록)을 *우선*. llm.json(구 CLI login 포맷)은 폴백. desktop 에선 config.json 이 라이브 선택의 SoT 이므로
		//    stale llm.json 이 가리면 안 된다(실측 회귀: stale llm.json main.provider=openai-compat 가 config.json 을 덮어
		//    채팅 전체 throw). config.json 부재/불완전이면 llm.json(CLI 로그인) 으로 폴백.
		return fromConfigJson(`${dir}/config.json`) ?? fromLlmJson(`${dir}/llm.json`);
		},
		loadMemoryConfig(adkPath) {
			if (!adkPath) return null;
			const dir = `${adkPath.replace(/\/+$/, "")}/naia-settings`;
			return fromConfigJsonMemory(`${dir}/config.json`);
		},
		loadEngineProfile(adkPath) {
			if (!adkPath) return null;
			const dir = `${adkPath.replace(/\/+$/, "")}/naia-settings`;
			return fromConfigJsonEngineProfile(`${dir}/config.json`);
		},
		loadLlmRoles(adkPath) {
			if (!adkPath) return null;
			const dir = `${adkPath.replace(/\/+$/, "")}/naia-settings`;
			return fromConfigJsonLlmRoles(`${dir}/config.json`) ?? fromLlmJsonLlmRoles(`${dir}/llm.json`);
		},
	};
}
