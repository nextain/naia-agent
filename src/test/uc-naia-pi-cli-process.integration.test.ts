import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ProcessResult = { code: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

describe("UC-NAIA-PI actual CLI process and stored login", () => {
  const home = mkdtempSync(join(tmpdir(), "naia-pi-cli-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "naia-pi-cli-work-"));
  const cli = resolve("bin/naia-agent.mjs");
  let baseUrl = "";
  let upstreamCalls = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { model?: string; gateway_request_id?: string; gateway_attempt?: number };
      upstreamCalls += 1;
      expect(body.model).toBe("grok-4.3");
      expect(req.headers["x-anyllm-key"]).toBe("Bearer stored-test-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-cli", model: "grok-4.3",
        gateway_request_id: body.gateway_request_id, gateway_attempt: body.gateway_attempt,
        settlement_status: "settled", billing_status: "settled", customer_cost: "0.00010000",
        price_version_id: "test-price-v1", currency: "USD",
        choices: [{ index: 0, message: { role: "assistant", content: "controlled cli ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      }));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const dir of [home, workdir]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* late Windows handles */ }
    }
  });

  it("reuses isolated-home login and produces equivalent direct/parent JSON evidence", async () => {
    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      NAIA_ANYLLM_BASE_URL: baseUrl,
      NAIA_API_KEY: undefined,
      NAIA_ANYLLM_API_KEY: undefined,
    } as NodeJS.ProcessEnv;
    delete env.NAIA_API_KEY;
    delete env.NAIA_ANYLLM_API_KEY;

    if (process.platform === "win32") {
      const login = await run(process.execPath, [cli, "login", "--provider", "naia", "--key", "stored-test-key"], env);
      expect(login.code).toBe(0);
      const blob = readFileSync(join(home, "naia-adk", "naia-settings", ".keys", "NAIA_ANYLLM_API_KEY.dpapi"));
      expect(blob.toString("utf8")).not.toContain("stored-test-key");
    } else {
      // Cross-platform process test keeps legacy read compatibility; secure secret-tool write is host-specific.
      mkdirSync(join(home, ".naia-agent"), { recursive: true });
      writeFileSync(join(home, ".naia-agent", ".env"), "NAIA_API_KEY=stored-test-key\n", { mode: 0o600 });
    }

    const args = [cli, "run", "Return a short controlled answer.", "--agent", "pi", "--model", "grok-4.3", "--workdir", workdir, "--json"];
    const direct = await run(process.execPath, args, env);
    const wrapper = [
      "const {spawn}=require('node:child_process');",
      "const [bin,...rest]=process.argv.slice(1);",
      "const c=spawn(process.execPath,[bin,...rest],{env:process.env,stdio:['ignore','pipe','pipe']});",
      "c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);c.on('close',code=>process.exitCode=code??1);",
    ].join("");
    const parent = await run(process.execPath, ["-e", wrapper, ...args], env);

    expect(direct.code, direct.stderr).toBe(0);
    expect(parent.code, parent.stderr).toBe(0);
    const directReport = JSON.parse(direct.stdout.trim());
    const parentReport = JSON.parse(parent.stdout.trim());
    for (const report of [directReport, parentReport]) {
      expect(report.sessionOk).toBe(true);
      expect(report.modelEvidence).toMatchObject({ provider: "naia", selectedModel: "grok-4.3", totalTokens: 7 });
    }
    const withoutVolatileIds = (report: typeof directReport) => {
      const copy = structuredClone(report);
      delete copy.modelEvidence.sessionId;
      delete copy.modelEvidence.executionId;
      for (const receipt of copy.modelEvidence.gatewayBillingReceipts ?? []) {
        delete receipt.executionId;
        delete receipt.localRequestId;
        delete receipt.gatewayRequestId;
      }
      return copy;
    };
    expect(withoutVolatileIds(parentReport)).toEqual(withoutVolatileIds(directReport));
    expect(upstreamCalls).toBe(2);

    const beforeRejected = upstreamCalls;
    const rejected = await run(process.execPath, [cli, "run", "code", "--agent", "pi", "--model", "deepseek-v4-pro", "--workdir", workdir, "--json"], env);
    expect(rejected.code).toBe(3);
    expect(upstreamCalls).toBe(beforeRejected);
  }, 60_000);
});
