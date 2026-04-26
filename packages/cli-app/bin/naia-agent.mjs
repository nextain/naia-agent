#!/usr/bin/env node
/**
 * R4 Phase 4.1 Day 3.3 — naia-agent CLI entry shim.
 *
 * Modes:
 *   --mode tauri-stdio   Tauri shell IPC mode (StdioDispatcher + IpcApprovalBroker
 *                         + handshake). Used by naia-os shell spawn_agent_core().
 *   --mode cli (default) Phase 1+2 production CLI (Phase1Supervisor + CliApprovalBroker).
 *                         Reserved for future implementation.
 *
 * Phase 4.1 status: tauri-stdio mode is **scaffolding only** — wires up the
 * dispatcher + broker + handshake and emits a 'ready' event. LLM core integration
 * happens in Day 4-5 (Day 1.1 interface mapping). For now this shim:
 *   1. Parses --mode / --version flags.
 *   2. Instantiates StdioDispatcher + IpcApprovalBroker (mode: dispatched).
 *   3. Awaits handshake.
 *   4. Emits a `ready` event so shell knows the agent is up.
 *   5. Idle until SIGTERM/SIGINT (Day 4-5: Agent.run loop here).
 *
 * Adversarial review (Day 2 cumulative) fixes:
 *   - P0-1: handshake protocol negotiation (StdioDispatcher built-in).
 *   - P0-2: frame multiplexing (StdioDispatcher routes by kind, not approval-only).
 *   - P1-2: bin shim now exists (was previously spec-only).
 *
 * Spec: r4-phase4-day1-4-spawn-pattern.md §2.1
 */

import { StdioDispatcher, IpcApprovalBroker } from "../dist/index.js";

// ─── argv parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = {
  mode: "cli",
  version: false,
  help: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--mode" && i + 1 < argv.length) {
    args.mode = argv[++i];
  } else if (a === "--version" || a === "-v") {
    args.version = true;
  } else if (a === "--help" || a === "-h") {
    args.help = true;
  }
}

const PROTOCOL_VERSION = "1";
const PACKAGE_VERSION = "0.1.0";

if (args.version) {
  process.stdout.write(`naia-agent ${PACKAGE_VERSION} (protocol ${PROTOCOL_VERSION})\n`);
  process.exit(0);
}

if (args.help) {
  process.stdout.write(`naia-agent ${PACKAGE_VERSION}

Usage: naia-agent [options]

Options:
  --mode <mode>     Operating mode: 'tauri-stdio' (Tauri IPC) or 'cli' (terminal).
                    Default: 'cli'.
  --version, -v     Print version and exit.
  --help, -h        Print this help and exit.

Modes:
  tauri-stdio       JSON frame protocol over stdio (host = naia-os shell).
                    Performs handshake, then routes inbound frames by kind to
                    registered handlers (approval, chat, panel_*, etc.).
  cli               (Reserved for Phase 1+2 production REPL — not yet wired here.)

Protocol: ${PROTOCOL_VERSION}
`);
  process.exit(0);
}

// ─── tauri-stdio mode ────────────────────────────────────────────────────────
if (args.mode === "tauri-stdio") {
  // Verify non-TTY stdin (sanity).
  if (process.stdin.isTTY) {
    process.stderr.write("[naia-agent] --mode tauri-stdio requires non-TTY stdin (JSON frames over pipe). Aborting.\n");
    process.exit(2);
  }

  // Construct dispatcher (handshake gate enforced).
  // Day 3 review (P0-NEW-2) — only advertise capabilities ACTUALLY implemented
  // in this build. Day 4-5 will add more (llm_chat, tool_execution, memory_*).
  // False advertising would let host trust capabilities the agent can't fulfill.
  const dispatcher = new StdioDispatcher({
    in: process.stdin,
    out: process.stdout,
    handshakeTimeoutMs: 10_000,  // Day 1.4 §3 — Flatpak cold start 8-10s
    agentCapabilities: [
      "approval_request",  // Day 2 — IpcApprovalBroker
      "skill_list",        // Day 3 — empty stub (returns []), Phase 4.2 wires real list
    ],
  });

  // Construct broker in dispatched mode + attach.
  const broker = new IpcApprovalBroker({
    out: process.stdout,
    mode: "dispatched",
  });
  broker.attachToDispatcher(dispatcher);

  // Phase 4.1 Day 3 scaffold — additional handler stubs.
  // Day 4-5 wire: replace stubs with Agent.run / SkillRegistry / Memory dispatch.
  dispatcher.register("chat", (frame) => {
    process.stderr.write(
      `[naia-agent] chat frame received (id=${frame.id}) — Day 4-5 wire pending\n`,
    );
  });
  dispatcher.register("tool_direct", (frame) => {
    process.stderr.write(
      `[naia-agent] tool_direct frame received (id=${frame.id}) — Phase 4.2 wire pending\n`,
    );
  });
  dispatcher.register("skill_list", (frame) => {
    // Minimal viable response — empty skill list. Phase 4.2 supervises.
    process.stdout.write(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: frame.id,
        type: "response",
        payload: { kind: "skill_list_response", tools: [] },
      }) + "\n",
    );
  });

  dispatcher.start();

  // Emit ready event after handshake (poll lightly — handshake is async).
  const checkReady = () => {
    if (dispatcher.handshakeComplete) {
      process.stdout.write(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          id: `ready-${Date.now()}`,
          type: "event",
          payload: { kind: "ready" },
        }) + "\n",
      );
    } else {
      setTimeout(checkReady, 50);
    }
  };
  checkReady();

  // Graceful shutdown.
  const shutdown = () => {
    process.stderr.write("[naia-agent] shutdown signal — closing dispatcher + broker\n");
    dispatcher.close();
    broker.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep process alive.
  // (dispatcher's readline holds the event loop while stdin is open.)
} else {
  process.stderr.write(`[naia-agent] mode '${args.mode}' not yet implemented. Use --mode tauri-stdio for now.\n`);
  process.exit(1);
}
