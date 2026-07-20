// UC-memory — 실 *프로세스* 관통(gRPC 진입점 lifecycle). in-memory writer 가 못 잡는 회귀를 실 OS
// 프로세스 + gRPC transport + SIGTERM 종료 경계에서 검증: ① 2턴 chat 이 gRPC 로 관통하고 턴1 save →
// 턴2 recall→systemPrompt 주입(echo provider 가 wire 로 반향)이 실 프로세스에서 동작 ② SIGTERM 종료가
// (drain→memory.close→flush→exit 0) 로 save 를 store 에 영속한다.
// 진입점은 dist 를 import 하므로 beforeAll 에서 빌드한다(self-contained).
// transport=gRPC(stdio 이식 후) → 옛 stdin/stdout JSON 라인이 아니라 GRPC_LISTENING 핸드셰이크 + gRPC 클라.
// provider/config 는 wire 가 아니라 naia-adk settings(`<adk>/naia-settings/config.json`)에서 로딩(canon).
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const pkgRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))); // src/test → 패키지 루트
const entry = join(pkgRoot, "scripts", "builds", "agent-stdio-entry.mjs");
const PROTO = join(pkgRoot, "src", "main", "adapters", "grpc", "naia_agent.proto");

// biome-ignore lint/suspicious/noExplicitAny: proto-loader 동적 타입(테스트 전용 클라이언트)
function makeClient(addr: string): any {
  const pkgDef = protoLoader.loadSync(PROTO, { keepCase: false, longs: Number, defaults: true, oneofs: true });
  // biome-ignore lint/suspicious/noExplicitAny: 동적 proto
  const proto = grpc.loadPackageDefinition(pkgDef) as any;
  return new proto.naia.agent.v1.NaiaAgent(addr, grpc.credentials.createInsecure());
}

// 한 chat 턴(server-stream)을 구동해 finish(스트림 end)까지 누적 text 반환.
// biome-ignore lint/suspicious/noExplicitAny: 동적 클라이언트/이벤트
function chatTurn(client: any, requestId: string, content: string): Promise<string> {
  return new Promise((res, rej) => {
    let text = "";
    const call = client.chat({ requestId, messages: [{ role: "user", content }] });
    // biome-ignore lint/suspicious/noExplicitAny: AgentEvent oneof
    call.on("data", (ev: any) => { if (ev.event === "text" && ev.text) text += ev.text.text ?? ""; });
    call.on("end", () => res(text));
    call.on("error", (e: Error) => rej(e));
  });
}

describe("UC-memory — 실 프로세스 관통(gRPC 진입점 종료 lifecycle)", () => {
  beforeAll(() => {
    // 진입점이 import 하는 dist 를 최신화(없거나 stale 이면 테스트가 옛 코드를 구동).
    // shell:true so the npx launcher resolves on Windows (npx.cmd) as well as POSIX.
    const r = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: pkgRoot, encoding: "utf8", timeout: 120000, shell: true });
    if (r.status !== 0) throw new Error(`dist 빌드 실패: ${r.stderr || r.stdout}`);
  }, 130000);

  let dir: string | null = null;
  let child: ChildProcess | null = null;
  afterEach(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    child = null;
    if (dir) { await rm(dir, { recursive: true, force: true }); dir = null; }
  });

  it("실 진입점 2턴 e2e(gRPC): 턴1 save → 턴2 recall→systemPrompt 주입(echo provider) + SIGTERM 영속", async () => {
    dir = await mkdtemp(join(tmpdir(), "naia-mem-proc-"));
    const storePath = join(dir, "store.json");
    const SECRET = "ProcZephyrLambda";

    // provider/config 는 naia-adk settings 에서 로딩(canon) — wire 에 provider 안 실음.
    // echo-system provider 포트(AGENT_PROVIDER)는 동작을 담당, config 는 activeConfig 존재만 충족.
    await mkdir(join(dir, "naia-settings"), { recursive: true });
    await writeFile(join(dir, "naia-settings", "config.json"), JSON.stringify({ provider: "echo-system", model: "m" }));

    child = spawn(process.execPath, [entry], {
      cwd: pkgRoot,
      // AGENT_PROVIDER=echo-system → provider 가 systemPrompt 를 그대로 echo → recall 이 주입했으면 wire 에 나옴.
      env: { ...process.env, AGENT_PROVIDER: "echo-system", NAIA_AGENT_SKILLS: "off", NAIA_MEMORY_STORE: storePath, NAIA_ADK_PATH: dir },
      stdio: ["pipe", "pipe", "ignore"],
    });

    // GRPC_LISTENING <addr> 핸드셰이크(stdout). gRPC 이식 후 stdout = 이 한 줄(다른 로그는 stderr).
    const addr = await new Promise<string>((res, rej) => {
      let buf = "";
      const to = setTimeout(() => rej(new Error("GRPC_LISTENING 타임아웃")), 60000);
      child!.stdout!.setEncoding("utf8");
      child!.stdout!.on("data", (c: string) => {
        buf += c;
        const m = buf.match(/GRPC_LISTENING\s+(\S+)/);
        if (m) { clearTimeout(to); res(m[1]); }
      });
      child!.on("exit", () => { clearTimeout(to); rej(new Error("리스닝 전 종료")); });
    });

    const client = makeClient(addr);
    // 턴1 — 사실 발화(save). 저장 전이라 systemPrompt(echo)에 비밀 없음(인과 분리).
    const t1 = await chatTurn(client, "p1", `내 비밀 코드명은 ${SECRET}야`);
    expect(t1).not.toContain(SECRET);
    // 턴2 — 턴1 의 사실 질문. recall 이 비밀을 systemPrompt 에 주입했으면 echo provider 가 wire 로 뱉음.
    const t2 = await chatTurn(client, "p2", "내 코드명이 뭐였지?");
    expect(t2).toContain(SECRET);
    client.close?.();

    // SIGTERM graceful shutdown(drain→flush→exit 0)은 **POSIX 계약** — Windows 는 SIGTERM 을 못 잡고
    // OS 가 강제종료(TerminateProcess, graceful flush 불가)하므로 이 단언은 POSIX 에서만 의미가 있다.
    // (위 2턴 recall→inject 관통은 전 플랫폼에서 이미 검증됨 — 이 분기는 종료 lifecycle 만 가른다.)
    if (process.platform === "win32") {
      child!.kill("SIGKILL"); // Windows: graceful 불가 → 강제종료(테스트 정리)
    } else {
      // SIGTERM → drain(in-flight save 완료) → memory.close(flush) → exit 0.
      const exitCode: number = await new Promise((res) => {
        child!.on("exit", (code) => res(code ?? -1));
        child!.kill("SIGTERM");
      });
      expect(exitCode).toBe(0);
      // 영속(종료 flush) — recall 이 관통했음을 store 로도 증명.
      expect(await readFile(storePath, "utf8")).toContain(SECRET);
    }
  }, 90000);

  it("Discord secret-only stdin pipe를 닫은 뒤에만 gRPC runtime을 시작한다", async () => {
    dir = await mkdtemp(join(tmpdir(), "naia-discord-pipe-"));
    const token = "discord.canary-token";
    await mkdir(join(dir, "naia-settings"), { recursive: true });
    await writeFile(
      join(dir, "naia-settings", "config.json"),
      JSON.stringify({ provider: "echo-system", model: "m" }),
    );

    child = spawn(process.execPath, [entry], {
      cwd: pkgRoot,
      env: {
        ...process.env,
        AGENT_PROVIDER: "echo-system",
        NAIA_AGENT_SKILLS: "off",
        NAIA_ADK_PATH: dir,
        NAIA_DISCORD_TOKEN_PIPE: "stdin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin!.end(token);

    const addr = await new Promise<string>((resolveAddress, rejectAddress) => {
      let stdout = "";
      const timeout = setTimeout(
        () => rejectAddress(new Error(`GRPC_LISTENING timeout: ${stderr}`)),
        60_000,
      );
      child!.stdout!.setEncoding("utf8");
      child!.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        const match = stdout.match(/GRPC_LISTENING\s+(\S+)/);
        if (match) {
          clearTimeout(timeout);
          resolveAddress(match[1]);
        }
      });
      child!.once("exit", () => {
        clearTimeout(timeout);
        rejectAddress(new Error(`secret pipe runtime exited: ${stderr}`));
      });
    });

    expect(addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(child.exitCode).toBeNull();
    expect(stderr).not.toContain(token);
    const exitCode = await new Promise<number>((resolveExit) => {
      child!.once("exit", (code) => resolveExit(code ?? -1));
      child!.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
    });
    if (process.platform !== "win32") expect(exitCode).toBe(0);
  }, 90000);

  it("인증된 Shutdown RPC만 ACK 후 실 프로세스를 graceful exit 한다", async () => {
    dir = await mkdtemp(join(tmpdir(), "naia-shutdown-rpc-"));
    const shutdownNonce = "shutdown-test-nonce-opaque";
    await mkdir(join(dir, "naia-settings"), { recursive: true });
    await writeFile(
      join(dir, "naia-settings", "config.json"),
      JSON.stringify({ provider: "echo-system", model: "m" }),
    );

    child = spawn(process.execPath, [entry], {
      cwd: pkgRoot,
      env: {
        ...process.env,
        AGENT_PROVIDER: "echo-system",
        NAIA_AGENT_SKILLS: "off",
        NAIA_ADK_PATH: dir,
        NAIA_AGENT_SHUTDOWN_NONCE: shutdownNonce,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const addr = await new Promise<string>((resolveAddress, rejectAddress) => {
      let stdout = "";
      const timeout = setTimeout(() => rejectAddress(new Error(`GRPC_LISTENING timeout: ${stderr}`)), 60_000);
      child!.stdout!.setEncoding("utf8");
      child!.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        const match = stdout.match(/GRPC_LISTENING\s+(\S+)/);
        if (match) { clearTimeout(timeout); resolveAddress(match[1]); }
      });
      child!.once("exit", () => {
        clearTimeout(timeout);
        rejectAddress(new Error(`shutdown RPC runtime exited before listen: ${stderr}`));
      });
    });
    const client = makeClient(addr);
    await expect(new Promise((resolveShutdown, rejectShutdown) => {
      client.shutdown({ nonce: "wrong-nonce" }, (error: grpc.ServiceError | null, response: unknown) => {
        if (error) rejectShutdown(error);
        else resolveShutdown(response);
      });
    })).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    expect(child.exitCode).toBeNull();

    const exited = new Promise<number>((resolveExit) => {
      child!.once("exit", (code) => resolveExit(code ?? -1));
    });
    await expect(new Promise((resolveShutdown, rejectShutdown) => {
      client.shutdown({ nonce: shutdownNonce }, (error: grpc.ServiceError | null, response: unknown) => {
        if (error) rejectShutdown(error);
        else resolveShutdown(response);
      });
    })).resolves.toMatchObject({ ok: true });
    expect(await exited).toBe(0);
    expect(stderr).not.toContain(shutdownNonce);
    client.close?.();
  }, 90000);
});
