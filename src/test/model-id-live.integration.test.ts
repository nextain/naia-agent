// model-id-live.integration — (P04 live 검증, 키 인가 시에만) 각 provider /models GET 으로
//   registry 모델 ID 가 '실제 provider API 가 아는 ID' 인지 단언. codex HIGH4 대응:
//   정적 mock 은 모델 ID 환각/오타/deprecated 를 못 잡는다 — 이 경로만이 production API 로 잡는다.
//
// ⚠️ 무인(키 env 없음) = 전부 skip(네트워크 0). /models 는 read-only(과금 0). completion 호출 절대 안 함.
//   expected 목록은 naia-os registry.test.ts native 스냅샷과 동기화하되, '확실히 살아있는' 최신 ID 만 둔다
//   (deprecated 회색지대 gpt-5.2/5.1 은 의도적으로 제외 — 8월 전후 /models 미등재 가능, 별도 확인).
import { describe, it, expect } from "vitest";

interface Probe {
  env: string;
  url: string;
  headers: (k: string) => Record<string, string>;
  expected: string[];
  pick?: (json: unknown) => string[];
}

const openaiStyle = (json: unknown): string[] => {
  const data = (json as { data?: Array<{ id?: string }> }).data ?? [];
  return data.map((m) => m.id ?? "").filter(Boolean);
};
// Google generativelanguage openai-compat: id 가 "models/gemini-..." prefix 일 수 있다 → strip.
const geminiStyle = (json: unknown): string[] => {
  const data = (json as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; id?: string }> });
  const raw = (data.data ?? data.models ?? []).map((m) => (m.id ?? (m as { name?: string }).name ?? ""));
  return raw.map((s) => s.replace(/^models\//, "")).filter(Boolean);
};

const PROBES: Probe[] = [
  { env: "OPENAI_API_KEY", url: "https://api.openai.com/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }), expected: ["gpt-5.5", "gpt-5.4", "gpt-4o"] },
  { env: "XAI_API_KEY", url: "https://api.x.ai/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }), expected: ["grok-4.3", "grok-3-mini"] },
  { env: "GLM_API_KEY", url: "https://api.z.ai/api/coding/paas/v4/models", headers: (k) => ({ Authorization: `Bearer ${k}` }), expected: ["glm-5.2", "glm-5.1"] },
  { env: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/openai/models", headers: (k) => ({ Authorization: `Bearer ${k}` }), expected: ["gemini-3.5-flash", "gemini-2.5-flash"], pick: geminiStyle },
  { env: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1/models", headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }), expected: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"] },
];

describe("live model-id 검증 (키 인가 시 — registry ID ↔ provider /models, read-only)", () => {
  for (const p of PROBES) {
    const hasKey = !!process.env[p.env];
    it.skipIf(!hasKey)(`${p.env}: registry 모델 ID 가 /models 응답에 존재`, async () => {
      const resp = await fetch(p.url, { headers: p.headers(process.env[p.env] as string), signal: AbortSignal.timeout(10000) });
      expect(resp.ok, `${p.url} → ${resp.status} ${resp.statusText}`).toBe(true);
      const ids = (p.pick ?? openaiStyle)(await resp.json());
      const missing = p.expected.filter((m) => !ids.includes(m));
      expect(missing, `provider 가 모르는 registry ID(환각/오타/deprecated): ${missing.join(", ")}`).toEqual([]);
    });
  }
});
