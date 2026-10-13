// UC-STUDIO agent ports — alpha-adk #51 (post C adversarial must-fix)
import { describe, it, expect } from "vitest";
import { makeStudioService } from "../main/app/studio-service.ts";
import type { SingingBackendPort, SingingJobView, StudioSession } from "../main/ports/studio.ts";
import {
  createVersionGraph,
  addRevision,
  abCompare,
  VersionGraphError,
} from "../main/domain/studio-version.ts";
import {
  createProposal,
  applyProposalAction,
  approveProposal,
  resolveCapabilityOrUnsupported,
  ProposalError,
} from "../main/domain/studio-proposal.ts";
import { toUserFacingError, sanitizeInternalMessage } from "../main/domain/studio-error.ts";
import { normalizeMelodyCatalogItem, normalizeAlignment } from "../main/domain/studio-melody.ts";

function validVoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "vp-1",
    displayName: "Alpha",
    previewRef: "preview:vp-1",
    consent: {
      status: "granted",
      scope: ["singing", "preview"],
      recordedAt: "2026-09-01T00:00:00.000Z",
    },
    provenance: "test",
    subject: "user:test",
    usageScope: ["singing", "preview"],
    storageLocator: "voices/vp-1",
    derivativePolicy: "keep",
    ...overrides,
  };
}

function fakeBackend(opts?: {
  preview?: boolean;
  segment?: boolean;
  failStatus?: boolean;
  advance?: boolean;
}): SingingBackendPort & { jobs: Map<string, SingingJobView> } {
  const jobs = new Map<string, SingingJobView>();
  let n = 0;
  const advance = opts?.advance ?? true;
  return {
    jobs,
    async capability() {
      return {
        supportsPreview: opts?.preview ?? false,
        supportsSegmentEdit: opts?.segment ?? false,
        maxDurationSec: 300,
        languages: ["ko"],
        failureCodes: ["capability_denied", "synthesize_failed", "preview_unsupported"],
      };
    },
    async createJob(input) {
      if (input.kind === "preview" && !(opts?.preview ?? false)) {
        const err = new Error("preview_unsupported");
        (err as { code?: string }).code = "preview_unsupported";
        throw err;
      }
      if (input.kind === "segment_edit" && !(opts?.segment ?? false)) {
        const err = new Error("segment_edit_unsupported");
        (err as { code?: string }).code = "segment_edit_unsupported";
        throw err;
      }
      const id = `job:${++n}`;
      const job: SingingJobView = { id, state: "queued", kind: input.kind ?? "full" };
      jobs.set(id, job);
      return job;
    },
    async status(jobId) {
      if (opts?.failStatus) throw new Error("down");
      const job = jobs.get(jobId);
      if (!job) throw new Error("missing");
      if (advance) {
        if (job.state === "queued") job.state = "running";
        else if (job.state === "running") {
          job.state = "succeeded";
          job.artifactRef = `artifact:${jobId}`;
        }
      }
      return { ...job };
    },
    async cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new Error("missing");
      job.state = "cancelled";
      job.failureCode = "cancelled";
      return { ...job };
    },
  };
}

async function readySession(svc: ReturnType<typeof makeStudioService>, backend = fakeBackend()) {
  let session: StudioSession = { correlationId: "c1" };
  const prepared = svc.prepareVoice(session, validVoice());
  expect(prepared.ok).toBe(true);
  session = prepared.value!;
  const aligned = svc.setAlignment(session, {
    melodyRef: "melody:moon",
    lyricsRef: "lyrics:moon",
    alignmentRef: "align:moon",
  });
  expect(aligned.ok).toBe(true);
  return { svc, session: aligned.value!, backend };
}

describe("melody/alignment contracts", () => {
  it("rejects raw midi/absolute paths", () => {
    expect(() =>
      normalizeMelodyCatalogItem({
        id: "m1",
        title: "Moon",
        originType: "catalog",
        licenseNotice: "demo",
        opaqueScoreRef: "/tmp/x.mid",
        midiBytes: [1],
      }),
    ).toThrow();
    expect(() =>
      normalizeAlignment({ melodyRef: "m", lyricsRef: "l", alignmentRef: "a", bytes: [1] }),
    ).toThrow();
    const item = normalizeMelodyCatalogItem({
      id: "m1",
      title: "Moon",
      originType: "catalog",
      licenseNotice: "internal demo — no copyright determination",
      opaqueScoreRef: "score:moon",
    });
    expect(item.licenseNotice.length).toBeGreaterThan(0);
  });
});

describe("VersionGraph", () => {
  it("rejects orphan and same A/B", () => {
    const g0 = createVersionGraph({ id: "v0", artifactRef: "a0" });
    expect(() => addRevision(g0, { id: "v1", artifactRef: "a1", parentId: "missing" })).toThrow(
      VersionGraphError,
    );
    const g1 = addRevision(g0, { id: "v1", artifactRef: "a1", parentId: "v0" });
    expect(() => abCompare(g1, "v0", "v0")).toThrow(VersionGraphError);
  });
});

describe("RevisionProposal FSM", () => {
  it("requires awaiting_approval before approve", () => {
    const p = createProposal({
      id: "p1",
      title: "Louder chorus",
      range: { startMs: 0, endMs: 1000 },
      lyricExcerpt: "la",
      userRequest: "louder",
      aiInterpretation: "increase energy",
      impact: "segment",
      expectedResult: "new take",
      previewAvailable: false,
      baseVersionId: "v0",
      capabilityRequired: ["supportsSegmentEdit"],
      correlationId: "corr-1",
    });
    expect(() => approveProposal(p)).toThrow(ProposalError);
    expect(approveProposal(applyProposalAction(p, "await_approval")).status).toBe("generating");
  });

  it("marks unsupported when capability missing", () => {
    const p = createProposal({
      id: "p2",
      title: "Edit",
      range: { startMs: 0, endMs: 1 },
      lyricExcerpt: "x",
      userRequest: "fix",
      aiInterpretation: "fix",
      impact: "seg",
      expectedResult: "y",
      previewAvailable: true,
      baseVersionId: "v0",
      capabilityRequired: ["supportsSegmentEdit"],
      correlationId: "corr-2",
    });
    expect(resolveCapabilityOrUnsupported(p, { supportsPreview: false, supportsSegmentEdit: false }).status).toBe(
      "unsupported",
    );
  });
});

describe("UserFacingError", () => {
  it("includes correlationId and strips model slugs", () => {
    const err = toUserFacingError("job_failed", "corr-9", ["retry"], true);
    expect(err.correlationId).toBe("corr-9");
    expect(sanitizeInternalMessage("tcsinger2 crashed")).not.toMatch(/tcsinger/i);
  });
});

describe("StudioService", () => {
  it("first generation builds original graph without silent second revision", async () => {
    const backend = fakeBackend();
    const { svc, session } = await readySession(makeStudioService(backend), backend);
    const started = await svc.startGeneration(session);
    expect(started.ok).toBe(true);
    let s = started.value!.session;
    await svc.refreshJob(s);
    const done = await svc.refreshJob(s);
    expect(done.ok).toBe(true);
    s = done.value!.session;
    expect(s.graph?.originalId).toBeTruthy();
    const again = await svc.refreshJob(s);
    expect(again.ok).toBe(true);
    expect(Object.keys(again.value!.session.graph!.nodes)).toHaveLength(1);
  });

  it("blocks startGeneration once graph exists", async () => {
    const backend = fakeBackend();
    const { svc, session } = await readySession(makeStudioService(backend), backend);
    const started = await svc.startGeneration(session);
    let s = started.value!.session;
    await svc.refreshJob(s);
    const done = await svc.refreshJob(s);
    s = done.value!.session;
    const blocked = await svc.startGeneration(s);
    expect(blocked.ok).toBe(false);
  });

  it("UT-NS-005: no revision before approve; unsupported when segment required", async () => {
    const backend = fakeBackend({ segment: false });
    const { svc, session } = await readySession(makeStudioService(backend), backend);
    const started = await svc.startGeneration(session);
    let s = started.value!.session;
    await svc.refreshJob(s);
    s = (await svc.refreshJob(s)).value!.session;
    const opened = svc.openProposal(s, {
      id: "p9",
      title: "t",
      range: { startMs: 0, endMs: 10 },
      lyricExcerpt: "x",
      userRequest: "fix",
      aiInterpretation: "fix",
      impact: "seg",
      expectedResult: "y",
      previewAvailable: false,
      baseVersionId: s.graph!.activeId,
      capabilityRequired: ["supportsSegmentEdit"],
    });
    expect(opened.ok).toBe(true);
    const waiting = svc.markAwaitingApproval(opened.value!);
    expect(waiting.ok).toBe(true);
    const approved = await svc.approveProposal(waiting.value!);
    expect(approved.ok).toBe(false);
    expect(approved.error?.alternatives).toContain("regenerate_all");
    expect(Object.keys(opened.value!.graph!.nodes)).toHaveLength(1);
  });

  it("approved regenerate-all appends exactly one revision", async () => {
    const backend = fakeBackend({ segment: false });
    const { svc, session } = await readySession(makeStudioService(backend), backend);
    let s = (await svc.startGeneration(session)).value!.session;
    await svc.refreshJob(s);
    s = (await svc.refreshJob(s)).value!.session;
    const opened = svc.openProposal(s, {
      id: "p10",
      title: "regen",
      range: { startMs: 0, endMs: 1 },
      lyricExcerpt: "x",
      userRequest: "again",
      aiInterpretation: "full regen",
      impact: "all",
      expectedResult: "v2",
      previewAvailable: false,
      baseVersionId: s.graph!.activeId,
      capabilityRequired: [], // no segment requirement → full job allowed
    });
    s = svc.markAwaitingApproval(opened.value!).value!;
    const approved = await svc.approveProposal(s);
    expect(approved.ok).toBe(true);
    s = approved.value!.session;
    await svc.refreshJob(s);
    const done = await svc.refreshJob(s);
    expect(done.ok).toBe(true);
    expect(Object.keys(done.value!.session.graph!.nodes).length).toBe(2);
    expect(done.value!.session.proposal?.status).toBe("completed");
  });

  it("clarification enter/answer/await via port; approve without answer fails", async () => {
    const backend = fakeBackend();
    const { svc, session } = await readySession(makeStudioService(backend), backend);
    let s = (await svc.startGeneration(session)).value!.session;
    await svc.refreshJob(s);
    s = (await svc.refreshJob(s)).value!.session;
    const opened = svc.openProposal(s, {
      id: "p11",
      title: "q",
      range: { startMs: 0, endMs: 1 },
      lyricExcerpt: "x",
      userRequest: "??",
      aiInterpretation: "unclear",
      impact: "?",
      expectedResult: "?",
      previewAvailable: false,
      baseVersionId: s.graph!.activeId,
      capabilityRequired: [],
    });
    const asked = svc.requestClarification(opened.value!, {
      question: "Which section?",
      choices: ["verse", "chorus"],
    });
    expect(asked.ok).toBe(true);
    expect(asked.value!.proposal?.status).toBe("needs_clarification");
    const blocked = svc.markAwaitingApproval(asked.value!);
    expect(blocked.ok).toBe(false);
    const answered = svc.answerClarification(asked.value!, "chorus");
    expect(answered.ok).toBe(true);
    const marked = svc.markAwaitingApproval(answered.value!);
    expect(marked.ok).toBe(true);
    expect(marked.value!.proposal?.status).toBe("awaiting_approval");
  });

  it("revoke is non-retryable on startGeneration path", async () => {
    const { normalizeVoiceProfile } = await import("../main/domain/studio-voice-profile.ts");
    const svc = makeStudioService(fakeBackend());
    const prepared = svc.prepareVoice({ correlationId: "c-rev" }, validVoice());
    const revokedSession = {
      ...prepared.value!,
      voice: normalizeVoiceProfile(
        validVoice({
          consent: {
            status: "granted",
            scope: ["singing"],
            recordedAt: "2026-01-01T00:00:00.000Z",
            revokedAt: "2026-09-10T00:00:00.000Z",
          },
        }),
      ),
      melodyRef: "melody:moon",
      lyricsRef: "lyrics:moon",
    };
    const started = await svc.startGeneration(revokedSession);
    expect(started.ok).toBe(false);
    expect(started.error?.code).toBe("voice_consent_revoked");
    expect(started.error?.retryable).toBe(false);
  });

  it("rejects revoked voice and resume unknown", async () => {
    const svc = makeStudioService(fakeBackend());
    const res = svc.prepareVoice(
      { correlationId: "c2" },
      validVoice({
        consent: {
          status: "revoked",
          scope: ["singing"],
          recordedAt: "2026-09-01T00:00:00.000Z",
          revokedAt: "2026-09-10T00:00:00.000Z",
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.retryable).toBe(false);

    const resumeSvc = makeStudioService(fakeBackend({ failStatus: true }));
    const resumed = await resumeSvc.resumeAfterRestart({ correlationId: "c3", activeJobId: "job:missing" });
    expect(resumed.value!.job.state).toBe("unknown");
  });

  it("selectActive and abCompare via port", async () => {
    const backend = fakeBackend();
    const { svc, session } = await readySession(makeStudioService(backend), backend);
    let s = (await svc.startGeneration(session)).value!.session;
    await svc.refreshJob(s);
    s = (await svc.refreshJob(s)).value!.session;
    // manually add second node through approve path
    const opened = svc.openProposal(s, {
      id: "p12",
      title: "r",
      range: { startMs: 0, endMs: 1 },
      lyricExcerpt: "x",
      userRequest: "r",
      aiInterpretation: "r",
      impact: "all",
      expectedResult: "v2",
      previewAvailable: false,
      baseVersionId: s.graph!.activeId,
      capabilityRequired: [],
    });
    s = svc.markAwaitingApproval(opened.value!).value!;
    s = (await svc.approveProposal(s)).value!.session;
    await svc.refreshJob(s);
    s = (await svc.refreshJob(s)).value!.session;
    const ids = Object.keys(s.graph!.nodes);
    expect(ids.length).toBe(2);
    const cmp = svc.abCompare(s, ids[0]!, ids[1]!);
    expect(cmp.ok).toBe(true);
    const selected = svc.selectActive(s, ids[1]!);
    expect(selected.value!.graph!.activeId).toBe(ids[1]!);
  });
});
