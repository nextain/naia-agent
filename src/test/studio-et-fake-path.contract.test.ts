// E (#53) shared fake-path ET-NS-004~007 contract assertions (not product-ready)
import { describe, it, expect } from "vitest";
import { makeStudioService } from "../main/app/studio-service.ts";
import type { SingingBackendPort, SingingJobView, StudioSession } from "../main/ports/studio.ts";

function validVoice() {
  return {
    id: "vp-1",
    displayName: "Alpha",
    previewRef: "preview:vp-1",
    consent: { status: "granted", scope: ["singing", "preview"], recordedAt: "2026-09-01T00:00:00.000Z" },
    provenance: "test",
    subject: "user:test",
    usageScope: ["singing", "preview"],
    storageLocator: "voices/vp-1",
    derivativePolicy: "keep",
  };
}

function makeBackend(mode: "auto" | "fail" | "down" = "auto"): SingingBackendPort {
  const jobs = new Map<string, SingingJobView>();
  let n = 0;
  return {
    async capability() {
      return {
        supportsPreview: false,
        supportsSegmentEdit: false,
        maxDurationSec: 300,
        languages: ["ko"],
        failureCodes: ["synthesize_failed", "cancelled"],
      };
    },
    async createJob(input) {
      const id = `job:${++n}`;
      const job: SingingJobView = { id, state: "queued", kind: input.kind ?? "full" };
      jobs.set(id, job);
      return { ...job };
    },
    async status(jobId) {
      if (mode === "down") throw new Error("down");
      const job = jobs.get(jobId);
      if (!job) throw new Error("missing");
      if (mode === "fail") {
        job.state = "failed";
        job.failureCode = "synthesize_failed";
        return { ...job };
      }
      if (job.state === "queued") job.state = "running";
      else if (job.state === "running") {
        job.state = "succeeded";
        job.artifactRef = `artifact:${jobId}`;
      }
      return { ...job };
    },
    async cancel(jobId) {
      const job = jobs.get(jobId)!;
      job.state = "cancelled";
      job.failureCode = "cancelled";
      return { ...job };
    },
  };
}

async function sessionReady(svc: ReturnType<typeof makeStudioService>) {
  let session: StudioSession = { correlationId: "et-corr-1" };
  session = svc.prepareVoice(session, validVoice()).value!;
  session = svc.setAlignment(session, {
    melodyRef: "melody:moon",
    lyricsRef: "lyrics:moon",
    alignmentRef: "align:moon",
  }).value!;
  return session;
}

describe("ET fake-path (#53)", () => {
  it("ET-NS-004 unsupported before approve keeps version count", async () => {
    const svc = makeStudioService(makeBackend("auto"));
    let session = await sessionReady(svc);
    let r = await svc.startGeneration(session);
    session = r.value!.session;
    await svc.refreshJob(session);
    session = (await svc.refreshJob(session)).value!.session;
    const before = Object.keys(session.graph!.nodes).length;
    const opened = svc.openProposal(session, {
      id: "p1",
      title: "seg",
      range: { startMs: 0, endMs: 100 },
      lyricExcerpt: "x",
      userRequest: "louder here",
      aiInterpretation: "raise",
      impact: "segment",
      expectedResult: "v2",
      previewAvailable: false,
      baseVersionId: session.graph!.activeId,
      capabilityRequired: ["supportsSegmentEdit"],
    });
    session = svc.markAwaitingApproval(opened.value!).value!;
    r = await svc.approveProposal(session);
    expect(r.ok).toBe(false);
    expect(r.error?.alternatives).toContain("regenerate_all");
    expect(r.error?.correlationId).toBe("et-corr-1");
    expect(Object.keys(opened.value!.graph!.nodes).length).toBe(before);
  });

  it("ET-NS-005 original artifactRef immutable across A/B", async () => {
    const svc = makeStudioService(makeBackend("auto"));
    let session = await sessionReady(svc);
    session = (await svc.startGeneration(session)).value!.session;
    await svc.refreshJob(session);
    session = (await svc.refreshJob(session)).value!.session;
    const originalId = session.graph!.originalId;
    const originalArtifact = session.graph!.nodes[originalId]!.artifactRef;
    const opened = svc.openProposal(session, {
      id: "p2",
      title: "regen",
      range: { startMs: 0, endMs: 1 },
      lyricExcerpt: "x",
      userRequest: "again",
      aiInterpretation: "full",
      impact: "all",
      expectedResult: "v2",
      previewAvailable: false,
      baseVersionId: session.graph!.activeId,
      capabilityRequired: [],
    });
    session = svc.markAwaitingApproval(opened.value!).value!;
    session = (await svc.approveProposal(session)).value!.session;
    await svc.refreshJob(session);
    session = (await svc.refreshJob(session)).value!.session;
    expect(session.graph!.originalId).toBe(originalId);
    expect(session.graph!.nodes[originalId]!.artifactRef).toBe(originalArtifact);
    const ids = Object.keys(session.graph!.nodes);
    expect(ids.length).toBe(2);
    const cmp = svc.abCompare(session, ids[0]!, ids[1]!);
    expect(cmp.ok).toBe(true);
    const selected = svc.selectActive(session, ids[1]!);
    expect(selected.value!.graph!.nodes[originalId]!.artifactRef).toBe(originalArtifact);
  });

  it("ET-NS-006 failed job and resume unknown stay honest", async () => {
    const failSvc = makeStudioService(makeBackend("fail"));
    let session = await sessionReady(failSvc);
    session = { ...session, correlationId: "et-fail" };
    session = (await failSvc.startGeneration(session)).value!.session;
    await failSvc.refreshJob(session);
    const failed = await failSvc.refreshJob(session);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("job_failed");
    expect(failed.error?.correlationId).toBe("et-fail");

    const downSvc = makeStudioService(makeBackend("down"));
    const resumed = await downSvc.resumeAfterRestart({
      correlationId: "et-re",
      activeJobId: "job:x",
      activeJobKind: "full",
    });
    expect(resumed.value!.job.state).toBe("unknown");
  });

  it("ET-NS-007 shell/land leak tokens absent from agent public errors", async () => {
    const svc = makeStudioService(makeBackend("fail"));
    let session = await sessionReady(svc);
    session = (await svc.startGeneration(session)).value!.session;
    await svc.refreshJob(session);
    const failed = await svc.refreshJob(session);
    const blob = JSON.stringify(failed.error);
    expect(blob).not.toMatch(/naia-settings/i);
    expect(blob).not.toMatch(/GATEWAY_MASTER_KEY/i);
    expect(blob).not.toMatch(/tcsinger|dskr/i);
  });
});
