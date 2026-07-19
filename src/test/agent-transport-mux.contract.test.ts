import { describe, expect, it, vi } from "vitest";
import {
  makeCompositeAgentIngress,
  makePrefixedAgentEgress,
} from "../main/adapters/agent-transport-mux.js";
import type { AgentIngressPort } from "../main/ports/uc1.js";

describe("Discord + gRPC transport composition", () => {
  it("subscribes and unsubscribes every ingress", () => {
    const callbacks: ((value: never) => void)[] = [];
    const unsubscribes = [vi.fn(), vi.fn()];
    const inputs: AgentIngressPort[] = unsubscribes.map((unsubscribe) => ({
      onRequest(callback) { callbacks.push(callback as (value: never) => void); return unsubscribe; },
    }));
    const route = vi.fn();
    const unsubscribe = makeCompositeAgentIngress(inputs).onRequest(route);
    expect(callbacks).toHaveLength(2);
    unsubscribe();
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    expect(unsubscribes[1]).toHaveBeenCalledOnce();
  });

  it("routes discord-prefixed events only to Discord and everything else to gRPC", () => {
    const discord = { emit: vi.fn() };
    const grpc = { emit: vi.fn() };
    const egress = makePrefixedAgentEgress([{ prefix: "discord:", egress: discord }], grpc);
    egress.emit("discord:m1", { kind: "finish" });
    egress.emit("grpc-request", { kind: "finish" });
    expect(discord.emit).toHaveBeenCalledWith("discord:m1", { kind: "finish" });
    expect(grpc.emit).toHaveBeenCalledWith("grpc-request", { kind: "finish" });
  });
});
