// UC-memory — 실 *프로세스* 관통(진입점 lifecycle). in-memory writer 가 못 잡는 회귀를 실 OS
// 파이프 + process.exit 경계에서 검증: stdin EOF 시 (drain→memory.close→stdout flush→exit) 가
// ① 진행 중 턴의 wire 출력(text/usage/finish)을 유실 없이 내보내고 ② save 를 store 에 영속한다.
// 진입점은 dist 를 import 하므로 beforeAll 에서 빌드한다(self-contained).
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))); // src/test → 패키지 루트
const entry = join(pkgRoot, "scripts", "builds", "agent-stdio-entry.mjs");

describe("UC-memory — 실 프로세스 관통(진입점 종료 lifecycle)", () => {
  beforeAll(() => {
    // 진입점이 import 하는 dist 를 최신화(없거나 stale 이면 테스트가 옛 코드를 구동).
    const r = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: pkgRoot, encoding: "utf8", timeout: 120000 });
    if (r.status !== 0) throw new Error(`dist 빌드 실패: ${r.stderr || r.stdout}`);
  }, 130000);

  let dir: string | null = null;
  afterEach(async () => { if (dir) { await rm(dir, { recursive: true, force: true }); dir = null; } });

  it("실 진입점 2턴 e2e: 턴1 save → 턴2 recall→systemPrompt 주입(echo provider 로 wire 관통 확인) + 영속", async () => {
    dir = await mkdtemp(join(tmpdir(), "naia-mem-proc-"));
    const storePath = join(dir, "store.json");
    const SECRET = "ProcZephyrLambda";

    const child = spawn(process.execPath, [entry], {
      cwd: pkgRoot,
      // AGENT_PROVIDER=echo-system → provider 가 systemPrompt 를 그대로 echo → recall 이 주입했으면 wire 에 나옴.
      env: { ...process.env, AGENT_PROVIDER: "echo-system", NAIA_AGENT_SKILLS: "off", NAIA_MEMORY_STORE: storePath, NAIA_ADK_PATH: dir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    const finishes = () => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string }).filter((m) => m.type === "finish");
    const waitFinishes = async (n: number) => { for (let i = 0; i < 600; i++) { if (finishes().length >= n) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error(`finish<${n}`); };
    const textFor = (rid: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => m["type"] === "text" && m["requestId"] === rid).map((m) => String(m["text"])).join("");

    // 턴1 — 사실 발화(save). finish 후 턴2 전송(턴2 가 턴1 의 기억을 회상하는지 검증, gated 패턴).
    child.stdin.write(JSON.stringify({ type: "chat_request", requestId: "p1", provider: { provider: "fake", model: "m" }, messages: [{ role: "user", content: `내 비밀 코드명은 ${SECRET}야` }] }) + "\n");
    await waitFinishes(1);
    expect(textFor("p1")).not.toContain(SECRET); // 턴1: 저장 전이라 systemPrompt(echo)에 비밀 없음(인과 분리)
    // 턴2 — 턴1 의 사실을 질문. recall 이 비밀을 systemPrompt 에 주입했으면 echo provider 가 wire 로 뱉음.
    child.stdin.write(JSON.stringify({ type: "chat_request", requestId: "p2", provider: { provider: "fake", model: "m" }, messages: [{ role: "user", content: "내 코드명이 뭐였지?" }] }) + "\n");
    await waitFinishes(2);
    child.stdin.end();

    const exitCode: number = await new Promise((res) => child.on("exit", (code) => res(code ?? -1)));
    expect(exitCode).toBe(0);

    // ★ 핵심: 빌드된 진입점에서 동적 import → memory 주입 → recall → systemPrompt 주입 → provider 경로가
    //   실제로 관통됨을 wire 로 증명(턴2 응답 = echo(systemPrompt) 에 비밀 포함).
    expect(textFor("p2")).toContain(SECRET);
    // 영속도 함께(종료 flush).
    expect(await readFile(storePath, "utf8")).toContain(SECRET);
  }, 30000);
});
