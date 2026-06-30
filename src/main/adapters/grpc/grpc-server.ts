// adapters/grpc/grpc-server — naia_agent.proto 의 gRPC 서버. stdio.ts 와 동형(같은 AgentIngressPort/EgressPort 구현)
// → composition/도메인 불변(직교). proto↔domain 매핑은 grpc-codec(순수). transport 누수 없음(proto 타입은 이 adapter 안에만).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { AgentRequest, AgentEmit, ToolSpec } from "../../domain/chat.js";
import type { AgentIngressPort, AgentEgressPort, DiagnosticLog, Unsub } from "../../ports/uc1.js";
import {
  chatRequestToDomain, cancelToDomain, approvalToDomain, credsToDomain, toolRequestToDomain,
  emitToProto, type PbChatRequest, type PbCancel, type PbApproval, type PbCreds, type PbToolRequest,
} from "./grpc-codec.js";

// dist 에는 tsc 가 .proto 를 복사 안 함 → colocated(prod 번들 복사본) 우선, 없으면 src 원본(dev) fallback.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = [
  join(HERE, "naia_agent.proto"),
  join(HERE, "../../../../src/main/adapters/grpc/naia_agent.proto"),
].find((p) => existsSync(p)) ?? join(HERE, "naia_agent.proto");

export interface SettingsResult { loaded: boolean; provider: string; model: string }
/** UC-KNOWLEDGE-COMPILE (FR-KB-5) — CompileKnowledge RPC 결과(통계). proto camelCase 동형. */
export interface CompileKnowledgeResult { ok: boolean; scope: string; sourceCount: number; cardCount: number; entityCount: number; relationCount: number; error?: string }
/** F1 rich-health(신규계약 Diagnostics RPC). os InteroceptivePort.diagnostics rich payload. */
export interface DiagnosticsResult { version: string; uptimeMs: number; healthy: boolean; components: readonly { name: string; healthy: boolean }[] }

export interface GrpcServerDeps {
  bindAddr?: string;                                  // 기본 127.0.0.1:0(임의 포트). entry 가 주소 회수.
  onSetWorkspace: (adkPath: string) => SettingsResult; // naia-adk/naia-settings 로딩 결과(entry 제공)
  onReloadSettings: () => SettingsResult;
  // UC-KNOWLEDGE-COMPILE(FR-KB-5): 지식 컴파일 트리거(entry 주입, async). 미주입=unavailable(no-op 정직 보고).
  onCompileKnowledge?: (adkPath: string) => Promise<CompileKnowledgeResult>;
  onDiagnostics?: () => DiagnosticsResult;            // F1 rich-health(미주입 시 기본 healthy). Rust os-client=후속.
  // UC-PANEL(FR-PANEL): 환경 panel skill RPC → panel-tool-executor 연결(entry 주입). 미주입=panel 미지원(no-op).
  onRegisterPanelSkills?: (panelId: string, tools: ToolSpec[]) => void;
  onClearPanelSkills?: (panelId: string) => void;
  onListSkills?: () => readonly ToolSpec[];
  onPanelToolResult?: (requestId: string, toolCallId: string, output: string, success: boolean) => void;
  diag: DiagnosticLog;
}

export interface GrpcServer {
  ingress: AgentIngressPort;     // composition 에 주입(transport 무지)
  egress: AgentEgressPort;       // 동상 — emit → 해당 requestId 의 Chat stream 으로 라우팅
  start: () => Promise<string>;  // 바인딩 주소 반환
  shutdown: () => Promise<void>;
}

type WritableStream = grpc.ServerWritableStream<unknown, unknown>;

export function makeGrpcServer(deps: GrpcServerDeps): GrpcServer {
  const { diag } = deps;
  const safeLog = (m: string, c?: unknown) => { try { diag.log(m, c); } catch { /* egress no-throw 계약 보호 */ } };
  // requestId → 활성 Chat(server-stream) call. emit 라우팅 대상.
  const active = new Map<string, WritableStream>();
  // ingress cb(단일 구독) — RPC 핸들러가 도메인 req 를 이리로 흘린다(stdio onLine 등가).
  let onReq: ((req: AgentRequest) => void) | null = null;

  const ingress: AgentIngressPort = {
    onRequest(cb: (req: AgentRequest) => void): Unsub {
      onReq = cb;
      return () => { if (onReq === cb) onReq = null; };
    },
  };

  // egress: AgentEmit → proto → 해당 stream.write. finish/error 면 stream 종료(register-before-emit 로 유실 방지).
  const egress: AgentEgressPort = {
    emit(requestId: string, e: AgentEmit): void {
      const call = active.get(requestId);
      if (!call) { safeLog("grpc egress: 활성 stream 없음(드롭)", { requestId, kind: e.kind }); return; }
      try { call.write(emitToProto(requestId, e)); }
      catch (err) { safeLog("grpc egress write 실패", err); }
      if (e.kind === "finish" || e.kind === "error") {
        active.delete(requestId);
        try { call.end(); } catch { /* 이미 닫힘 */ }
      }
    },
  };

  // server-stream(Chat/ToolRequest): stream 등록 → 도메인 req 전달(register-before-emit). 클라 취소 시 정리.
  function streamHandler(toDomain: (p: unknown) => AgentRequest & { requestId: string }) {
    return (call: WritableStream) => {
      const req = toDomain(call.request);
      // 중복 requestId 거부 — 덮어쓰면 원 stream 이 영구 누수(codex 지적). 즉시 error + 종료.
      if (active.has(req.requestId)) {
        safeLog("grpc: 중복 requestId 거부", { requestId: req.requestId });
        try { call.write(emitToProto(req.requestId, { kind: "error", message: `중복 requestId: ${req.requestId}` })); call.end(); } catch { /* noop */ }
        return;
      }
      active.set(req.requestId, call);
      call.on("cancelled", () => { active.delete(req.requestId); });
      diag.debug?.("grpc ingress(stream)", { kind: req.kind, requestId: req.requestId });
      onReq?.(req);
    };
  }

  // unary(Cancel/Approval/Creds): 도메인 req 전달 후 Ack.
  function unaryHandler(toDomain: (p: unknown) => AgentRequest) {
    return (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<{ ok: boolean }>) => {
      const req = toDomain(call.request);
      diag.debug?.("grpc ingress(unary)", { kind: req.kind });
      onReq?.(req);
      cb(null, { ok: true });
    };
  }

  const impl = {
    setWorkspace: (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<SettingsResult>) => {
      const adkPath = String((call.request as { adkPath?: string })?.adkPath ?? "");
      diag.debug?.("grpc SetWorkspace", { adkPath });
      cb(null, deps.onSetWorkspace(adkPath));
    },
    reloadSettings: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<SettingsResult>) => {
      cb(null, deps.onReloadSettings());
    },
    // UC-KNOWLEDGE-COMPILE(FR-KB-5): async 컴파일. no-throw(미주입/실패=ok:false+error, RPC 안정). cb 단일호출.
    compileKnowledge: async (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<CompileKnowledgeResult>) => {
      const adkPath = String((call.request as { adkPath?: string })?.adkPath ?? "");
      diag.debug?.("grpc CompileKnowledge", { adkPath });
      const unavailable = (error: string): CompileKnowledgeResult => ({ ok: false, scope: "", sourceCount: 0, cardCount: 0, entityCount: 0, relationCount: 0, error });
      if (!deps.onCompileKnowledge) { cb(null, unavailable("compile unavailable")); return; }
      try { cb(null, await deps.onCompileKnowledge(adkPath)); }
      catch (e) { cb(null, unavailable(e instanceof Error ? e.message : String(e))); }
    },
    diagnostics: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<DiagnosticsResult>) => {
      cb(null, deps.onDiagnostics ? deps.onDiagnostics() : { version: "", uptimeMs: 0, healthy: true, components: [] }); // 미주입=기본 healthy
    },
    chat: streamHandler((p) => chatRequestToDomain(p as PbChatRequest)),
    toolRequest: streamHandler((p) => toolRequestToDomain(p as PbToolRequest)),
    cancel: unaryHandler((p) => cancelToDomain(p as PbCancel)),
    approvalResponse: unaryHandler((p) => approvalToDomain(p as PbApproval)),
    updateCreds: unaryHandler((p) => credsToDomain(p as PbCreds)),
    // UC-PANEL(FR-PANEL): 환경 panel skill RPC. parametersJson/tier(int) ↔ domain ToolSpec(parameters/tier:string) 변환.
    registerPanelSkills: (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<{ ok: boolean }>) => {
      const r = call.request as { panelId?: string; tools?: { name: string; description: string; parametersJson?: string; tier?: number }[] };
      const tools: ToolSpec[] = (r.tools ?? []).map((t) => {
        let parameters: unknown = {};
        try { if (t.parametersJson) parameters = JSON.parse(t.parametersJson); } catch { parameters = {}; }
        return { name: String(t.name ?? ""), description: String(t.description ?? ""), parameters, ...(t.tier != null && t.tier > 0 ? { tier: "ask" } : {}) }; // M1: int>0 → gated "ask"(UC5 승인), 0/미설정=none(생략). String(int) 의미손실 제거.
      });
      deps.onRegisterPanelSkills?.(String(r.panelId ?? ""), tools);
      cb(null, { ok: true });
    },
    clearPanelSkills: (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<{ ok: boolean }>) => {
      deps.onClearPanelSkills?.(String((call.request as { panelId?: string }).panelId ?? ""));
      cb(null, { ok: true });
    },
    listSkills: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<{ tools: unknown[] }>) => {
      const tools = deps.onListSkills?.() ?? [];
      cb(null, { tools: tools.map((t) => ({ name: t.name, description: t.description, parametersJson: JSON.stringify(t.parameters ?? {}), ...(t.tier != null && t.tier !== "none" ? { tier: 1 } : {}) })) }); // M1: gated→1, none/미설정 생략(Number("ask")=NaN 제거)
    },
    panelToolResult: (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<{ ok: boolean }>) => {
      const r = call.request as { requestId?: string; toolCallId?: string; output?: string; success?: boolean };
      deps.onPanelToolResult?.(String(r.requestId ?? ""), String(r.toolCallId ?? ""), String(r.output ?? ""), !!r.success); // H2: requestId+toolCallId 복합키
      cb(null, { ok: true });
    },
  };

  let server: grpc.Server | null = null;

  return {
    ingress,
    egress,
    start: () =>
      new Promise<string>((resolve, reject) => {
        const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: false, longs: Number, defaults: true, oneofs: true });
        const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
          naia: { agent: { v1: { NaiaAgent: { service: grpc.ServiceDefinition } } } };
        };
        server = new grpc.Server();
        server.addService(proto.naia.agent.v1.NaiaAgent.service, impl as unknown as grpc.UntypedServiceImplementation);
        const addr = deps.bindAddr ?? "127.0.0.1:0";
        server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
          if (err) { reject(err); return; }
          const bound = addr.includes(":0") ? addr.replace(/:0$/, `:${port}`) : addr;
          diag.log("grpc 서버 listening", { bound });
          resolve(bound);
        });
      }),
    shutdown: () =>
      new Promise<void>((resolve) => {
        for (const [, call] of active) { try { call.end(); } catch { /* noop */ } }
        active.clear();
        if (!server) { resolve(); return; }
        server.tryShutdown(() => resolve());
      }),
  };
}
