// adapters/keychain-secret-store — 키체인 backed CredentialPort (순수: 키체인 read 는 주입).
//
// naia-os 의 write_agent_key(Rust) 가 OS 키체인(Linux=secret-tool service=naia-agent account={env_key})에 쓴 키를
// agent 가 read-back 한다(별도 login 불요). ⚠️ src/main 은 순수 코어 → node:child_process 직접 import 금지:
// 실제 secret-tool spawn 은 .mjs 진입점(node)이 KeychainRead 로 주입(file-memo-store 의 nodeFs 주입과 동일 패턴).
// old-naia-os 표준 secret-store.ts(projects/naia-agent) 이식(classifyProbe 포함). plaintext fallback 절대 없음.
//
// 키 매핑(provider → apiKey env_key) = naia-os domain/config resolveAgentEnvKey 거울.
// naiaKey 는 provider 무관 NAIA_ANYLLM_API_KEY(로그인 키, lab-proxy 라우팅).
import type { CredentialPort } from "../ports/uc1.js";

/** 키체인 read 함수(name=env_key → value|undefined). .mjs 가 secret-tool/security/DPAPI 구현 주입. */
export type KeychainRead = (name: string) => string | undefined;

/** secret-tool lookup 결과 분류(locale-independent, 순수): 0=found, 1+빈stderr=absent(healthy), 그외=unavailable. old 이식. */
export function classifyProbe(r: { error?: unknown; status: number | null; stderr: string }): boolean {
	if (r.error || r.status === null) return false;
	if (r.status === 0) return true;
	if (r.status === 1 && r.stderr.trim() === "") return true;
	return false;
}

/** provider → apiKey env_key (naia-os resolveAgentEnvKey 거울). 키 없는 provider=null. */
export function apiKeyEnvFor(provider: string): string | null {
	switch (provider) {
		case "anthropic": return "ANTHROPIC_API_KEY";
		case "openai": return "OPENAI_API_KEY";
		case "glm":
		case "zai": return "GLM_API_KEY";
		case "gemini": return "GEMINI_API_KEY";
		case "xai": return "XAI_API_KEY";
		default: return null; // ollama/vllm/claude-code-cli 등 = 키 불요
	}
}

const NAIA_KEY_ENV = "NAIA_ANYLLM_API_KEY"; // 로그인 naiaKey(lab-proxy)

/**
 * 키체인 backed CredentialPort. read=주입(키체인 lookup). get(provider) = apiKey(provider env) + naiaKey(NAIA_ANYLLM_API_KEY).
 * update(provider, secret) = 런타임 overlay(creds_update 채널 — 키체인보다 우선, 메모리 only).
 * 값 없으면 필드 생략, 둘 다 없으면 undefined(호출측이 빈 키로 호출 안 하게).
 */
export function makeKeychainCredentials(deps: { read: KeychainRead }): CredentialPort {
	const read = deps.read;
	const overlay = new Map<string, { apiKey?: string; naiaKey?: string }>();
	return {
		update(provider, secret) {
			overlay.set(provider, secret);
		},
		get(provider) {
			const ov = overlay.get(provider);
			const out: { apiKey?: string; naiaKey?: string } = {};
			const ovApi = ov?.apiKey;
			if (ovApi) out.apiKey = ovApi;
			else {
				const envKey = apiKeyEnvFor(provider);
				const k = envKey ? read(envKey) : undefined;
				if (k) out.apiKey = k;
			}
			const ovNaia = ov?.naiaKey;
			if (ovNaia) out.naiaKey = ovNaia;
			else {
				const nk = read(NAIA_KEY_ENV);
				if (nk) out.naiaKey = nk;
			}
			return out.apiKey === undefined && out.naiaKey === undefined ? undefined : out;
		},
	};
}
