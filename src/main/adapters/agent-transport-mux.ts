import type { AgentEgressPort, AgentIngressPort } from "../ports/uc1.js";

export function makeCompositeAgentIngress(
  ingresses: readonly AgentIngressPort[],
): AgentIngressPort {
  return {
    onRequest(callback) {
      const subscriptions = ingresses.map((ingress) => ingress.onRequest(callback));
      return () => {
        for (const unsubscribe of subscriptions) {
          try { unsubscribe(); } catch { /* subscription isolation */ }
        }
      };
    },
  };
}

export function makePrefixedAgentEgress(
  routes: readonly { readonly prefix: string; readonly egress: AgentEgressPort }[],
  fallback: AgentEgressPort,
): AgentEgressPort {
  const prefixes = new Set<string>();
  for (const route of routes) {
    if (!route.prefix || prefixes.has(route.prefix)) throw new Error("AGENT_EGRESS_ROUTE_INVALID");
    prefixes.add(route.prefix);
  }
  return {
    emit(requestId, event) {
      const route = routes.find((candidate) => requestId.startsWith(candidate.prefix));
      (route?.egress ?? fallback).emit(requestId, event);
    },
    emitCritical(requestId, event) {
      const route = routes.find((candidate) => requestId.startsWith(candidate.prefix));
      return (route?.egress ?? fallback).emitCritical?.(requestId, event) ?? false;
    },
  };
}
