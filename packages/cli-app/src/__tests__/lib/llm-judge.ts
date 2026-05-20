/**
 * LLM-as-judge harness for integration scenarios.
 *
 * Provider resolution:
 *   GLM_API_KEY  → zai/Zhipu GLM (open.bigmodel.cn)  ← preferred
 *   OPENAI_API_KEY + OPENAI_BASE_URL → generic OpenAI-compat
 *   ANTHROPIC_API_KEY → Anthropic
 *   (none) → throws — caller may `skipUnlessJudge()`.
 *
 * Synthetic test inputs only; never user-private memory. See
 * memory entry feedback_naia_reasoning_locality.
 *
 * The judge model is deliberately a DIFFERENT family/size than the
 * model under test (e.g. judge=GLM, SUT=gemma4:31b), avoiding self-
 * judge bias.
 */
import { setTimeout as delay } from "node:timers/promises";

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
  raw?: string;
}

export interface JudgeOptions {
  /** Set false to skip self-consistency probe and any retry. */
  retryOnParseError?: boolean;
}

interface ProviderConfig {
  url: string;
  model: string;
  authHeader: string;
  authValue: string;
  bodyExtras?: Record<string, unknown>;
}

function resolveProvider(env: NodeJS.ProcessEnv): ProviderConfig | undefined {
  if (env.GLM_API_KEY) {
    return {
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: env.GLM_MODEL || "glm-4-flash",
      authHeader: "Authorization",
      authValue: `Bearer ${env.GLM_API_KEY}`,
      // Disable GLM-4.5 thinking so we get content not reasoning_content.
      bodyExtras: { thinking: { type: "disabled" } },
    };
  }
  if (env.OPENAI_API_KEY && env.OPENAI_BASE_URL) {
    return {
      url: `${env.OPENAI_BASE_URL.replace(/\/+$/, "")}/chat/completions`,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      authHeader: "Authorization",
      authValue: `Bearer ${env.OPENAI_API_KEY}`,
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    // Note: Anthropic uses a different shape — minimal mapper below.
    return {
      url: "https://api.anthropic.com/v1/messages",
      model: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      authHeader: "x-api-key",
      authValue: env.ANTHROPIC_API_KEY,
      bodyExtras: { anthropic: true },
    };
  }
  return undefined;
}

export function judgeAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!resolveProvider(env);
}

/** Strict JSON envelope; one-sentence reason. */
const JUDGE_SYSTEM = [
  "You are a strict but fair evaluator of agent test outputs.",
  "Reply with ONLY this JSON shape (no Markdown, no preamble):",
  '{"pass": boolean, "reason": "one short sentence"}',
  "Reasons may be Korean or English.",
].join("\n");

function buildUserPrompt(args: {
  scenarioId: string;
  description: string;
  expected: string;
  observed: string;
}): string {
  // Cap observed to avoid runaway prompt size.
  const observed =
    args.observed.length > 4000
      ? args.observed.slice(0, 4000) + "\n…[truncated]"
      : args.observed;
  return [
    `Scenario: ${args.scenarioId} — ${args.description}`,
    `Expected behavior:`,
    args.expected,
    ``,
    `Observed (verbatim; may include tool logs and stderr markers):`,
    `<<<`,
    observed,
    `>>>`,
    ``,
    `Did the observed output satisfy the expected behavior? JSON only.`,
  ].join("\n");
}

async function callOpenAILike(
  provider: ProviderConfig,
  messages: { role: string; content: string }[],
): Promise<string> {
  if ((provider.bodyExtras as { anthropic?: boolean } | undefined)?.anthropic) {
    // Map to Anthropic format.
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const userMsgs = messages.filter((m) => m.role !== "system");
    const body = {
      model: provider.model,
      max_tokens: 400,
      system,
      messages: userMsgs.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    };
    const r = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [provider.authHeader]: provider.authValue,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      throw new Error(`judge HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = (await r.json()) as { content?: { text?: string }[] };
    return j.content?.[0]?.text ?? "";
  }
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: 0,
    max_tokens: 4000,
    ...provider.bodyExtras,
  };
  // Strip our pseudo-flag.
  delete (body as { anthropic?: unknown }).anthropic;
  const r = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [provider.authHeader]: provider.authValue,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    throw new Error(`judge HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  const msg = j.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || "";
}

function parseJudge(raw: string): JudgeVerdict {
  if (!raw) return { pass: false, reason: "judge empty response", raw };
  // Try direct JSON first.
  const tries: string[] = [];
  tries.push(raw.trim());
  // Strip code fences.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) tries.push(fence[1].trim());
  // First {…} block.
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) tries.push(brace[0]);
  for (const t of tries) {
    try {
      const o = JSON.parse(t);
      if (typeof o.pass === "boolean" && typeof o.reason === "string") {
        return { pass: o.pass, reason: o.reason, raw };
      }
    } catch {
      // try next
    }
  }
  return { pass: false, reason: "judge parse error", raw };
}

/**
 * Evaluate one (scenario, observed) pair via the judge model.
 * Returns a verdict; on transport error returns fail-safe pass:false.
 */
export async function judge(
  args: {
    scenarioId: string;
    description: string;
    expected: string;
    observed: string;
  },
  options: JudgeOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<JudgeVerdict> {
  const provider = resolveProvider(env);
  if (!provider) {
    return { pass: false, reason: "no judge provider configured", raw: "" };
  }
  const messages = [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: buildUserPrompt(args) },
  ];
  let raw = "";
  try {
    raw = await callOpenAILike(provider, messages);
  } catch (e) {
    return { pass: false, reason: `judge transport error: ${(e as Error).message.slice(0, 120)}` };
  }
  const v = parseJudge(raw);
  if (v.reason === "judge parse error" && options.retryOnParseError !== false) {
    // single retry with stricter rider.
    await delay(500);
    try {
      const tighter = [
        { role: "system", content: JUDGE_SYSTEM + "\nReturn JSON immediately. No reasoning text." },
        { role: "user", content: buildUserPrompt(args) },
      ];
      raw = await callOpenAILike(provider, tighter);
    } catch (e) {
      return { pass: false, reason: `judge retry transport error: ${(e as Error).message.slice(0, 120)}` };
    }
    return parseJudge(raw);
  }
  return v;
}

/** Test the judge on the same (scenario, observed) twice — returns
 *  whether the two verdicts agree. Used for `judge_consistency_rate`. */
export async function judgeConsistencyProbe(
  args: { scenarioId: string; description: string; expected: string; observed: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ agree: boolean; v1: JudgeVerdict; v2: JudgeVerdict }> {
  const v1 = await judge(args, {}, env);
  const v2 = await judge(args, {}, env);
  return { agree: v1.pass === v2.pass, v1, v2 };
}
