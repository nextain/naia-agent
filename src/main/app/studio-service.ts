// app — Studio orchestration (alpha-adk #51). Depends on domain + ports only.

import {
  evaluateVoiceForGeneration,
  normalizeVoiceProfile,
  type VoiceUsageScope,
} from "../domain/studio-voice-profile.js";
import {
  approveProposal,
  createProposal,
  resolveCapabilityOrUnsupported,
  applyProposalAction,
  requestClarification,
  answerClarification,
  type RevisionProposal,
} from "../domain/studio-proposal.js";
import {
  addRevision,
  assertGraphHasNoAudioBytes,
  createVersionGraph,
  selectActive,
  abCompare,
  VersionGraphError,
} from "../domain/studio-version.js";
import { mapVoiceGateCode, toUserFacingError, sanitizeInternalMessage, type StudioErrorCode } from "../domain/studio-error.js";
import {
  normalizeAlignment,
  normalizeMelodyCatalogItem,
  MelodyContractError,
} from "../domain/studio-melody.js";
import { ProposalError } from "../domain/studio-proposal.js";
import type {
  SingingBackendPort,
  StudioAppResult,
  StudioServicePort,
  StudioSession,
  SingingJobView,
} from "../ports/studio.js";

function ok<T>(value: T): StudioAppResult<T> {
  return { ok: true, value };
}

function fail<T>(error: NonNullable<StudioAppResult<T>["error"]>): StudioAppResult<T> {
  return { ok: false, error };
}

function mapCaught(err: unknown, correlationId: string): NonNullable<StudioAppResult<unknown>["error"]> {
  const message = sanitizeInternalMessage(err instanceof Error ? err.message : String(err));
  const codeHint = err instanceof Error && "code" in err ? String((err as { code?: string }).code) : message;
  const table: Record<string, StudioErrorCode> = {
    preview_unsupported: "preview_unsupported",
    segment_edit_unsupported: "segment_edit_unsupported",
    capability_denied: "capability_denied",
    cancelled: "job_cancelled",
    synthesize_failed: "job_failed",
    invalid_input: "job_failed",
    illegal_transition: "internal_error",
    approve_without_wait: "unsupported_change",
  };
  for (const [k, v] of Object.entries(table)) {
    if (codeHint.includes(k) || message.includes(k)) {
      return toUserFacingError(v, correlationId, v === "unsupported_change" ? ["regenerate_all"] : ["retry"], v === "job_failed");
    }
  }
  if (err instanceof ProposalError || err instanceof VersionGraphError || err instanceof MelodyContractError) {
    return toUserFacingError("internal_error", correlationId, [], false);
  }
  return toUserFacingError("job_failed", correlationId, ["retry"], true);
}

function revalidateVoice(session: StudioSession): StudioAppResult<StudioSession> {
  if (!session.voice) {
    return fail(toUserFacingError("voice_profile_invalid", session.correlationId));
  }
  const gate = evaluateVoiceForGeneration(session.voice, ["singing"]);
  if (!gate.ok) return fail(mapVoiceGateCode(gate.code, session.correlationId));
  return ok(session);
}

export function makeStudioService(backend: SingingBackendPort): StudioServicePort {
  return {
    prepareVoice(session, rawVoice, scopes: VoiceUsageScope[] = ["singing"]) {
      const gate = evaluateVoiceForGeneration(rawVoice, scopes);
      if (!gate.ok) {
        const err = mapVoiceGateCode(gate.code, session.correlationId);
        if (gate.code === "voice_consent_revoked" || gate.code === "voice_consent_expired") {
          return fail({ ...err, retryable: false });
        }
        return fail(err);
      }
      try {
        const voice = normalizeVoiceProfile(rawVoice);
        return ok({ ...session, voice });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    setAlignment(session, alignment) {
      try {
        const normalized = normalizeAlignment(alignment);
        return ok({
          ...session,
          alignment: normalized,
          melodyRef: normalized.melodyRef,
          lyricsRef: normalized.lyricsRef,
        });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    listMelodyCatalog(items) {
      try {
        return ok(items.map((item) => normalizeMelodyCatalogItem(item)));
      } catch (err) {
        return fail(mapCaught(err, "catalog"));
      }
    },

    async startGeneration(session) {
      const voiceOk = revalidateVoice(session);
      if (!voiceOk.ok) return fail(voiceOk.error!);
      if (!session.melodyRef || !session.lyricsRef) {
        return fail(toUserFacingError("unsupported_change", session.correlationId, ["set_alignment"], false));
      }
      // If a graph already exists, first generation path is closed — use approve regenerate-all.
      if (session.graph) {
        return fail(toUserFacingError("unsupported_change", session.correlationId, ["regenerate_all_via_approve"], false));
      }
      try {
        const job = await backend.createJob({
          voiceId: session.voice!.id,
          melodyRef: session.melodyRef,
          lyricsRef: session.lyricsRef,
          kind: "full",
        });
        return ok({
          session: { ...session, activeJobId: job.id, activeJobKind: job.kind, pendingRevisionJobId: undefined },
          job,
        });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    async refreshJob(session) {
      if (!session.activeJobId) {
        return fail(toUserFacingError("job_failed", session.correlationId));
      }
      try {
        const job = await backend.status(session.activeJobId);
        let next = session;
        let proposal = session.proposal;

        if (job.state === "succeeded" && job.artifactRef) {
          assertGraphHasNoAudioBytes(
            session.graph ?? createVersionGraph({ id: `ver:${job.id}`, artifactRef: job.artifactRef }),
          );
          if (!session.graph) {
            const graph = createVersionGraph({ id: `ver:${job.id}`, artifactRef: job.artifactRef });
            assertGraphHasNoAudioBytes(graph);
            next = { ...session, graph };
          } else if (session.pendingRevisionJobId && session.pendingRevisionJobId === job.id) {
            // Only approved revision jobs may append versions.
            const parentId = session.proposal?.baseVersionId ?? session.graph.activeId;
            const revId = `ver:${job.id}:r`;
            if (!session.graph.nodes[revId]) {
              const graph = addRevision(session.graph, {
                id: revId,
                artifactRef: job.artifactRef,
                parentId,
              });
              assertGraphHasNoAudioBytes(graph);
              if (proposal && proposal.status === "generating") {
                proposal = { ...applyProposalAction(proposal, "complete"), newVersionId: revId };
              }
              next = { ...session, graph, proposal, pendingRevisionJobId: undefined };
            }
          }
          // Idempotent: succeeded original without pending revision → return graph as-is.
        }

        if (job.state === "failed") {
          if (proposal && proposal.status === "generating") {
            proposal = applyProposalAction(proposal, "fail");
            next = { ...next, proposal };
          }
          return {
            ok: false,
            value: { session: next, job },
            error: toUserFacingError("job_failed", session.correlationId, ["retry"], true),
          };
        }
        if (job.state === "cancelled") {
          if (proposal && proposal.status === "generating") {
            proposal = applyProposalAction(proposal, "fail");
            next = { ...next, proposal };
          }
          return {
            ok: false,
            value: { session: next, job },
            error: toUserFacingError("job_cancelled", session.correlationId),
          };
        }
        return ok({ session: next, job });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    async resumeAfterRestart(session) {
      if (!session.activeJobId) {
        return ok({
          session,
          job: { id: "none", state: "unknown", kind: session.activeJobKind ?? "full" },
        });
      }
      try {
        const job = await backend.status(session.activeJobId);
        return ok({ session, job });
      } catch {
        return ok({
          session,
          job: {
            id: session.activeJobId,
            state: "unknown",
            kind: session.activeJobKind ?? "full",
          },
        });
      }
    },

    openProposal(session, draft) {
      try {
        if (!session.graph) {
          return fail(toUserFacingError("unsupported_change", session.correlationId, ["generate_first"]));
        }
        const proposal = createProposal({
          ...draft,
          correlationId: session.correlationId,
          baseVersionId: draft.baseVersionId || session.graph.activeId,
        });
        return ok({ ...session, proposal });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    requestClarification(session, clarification) {
      try {
        if (!session.proposal) {
          return fail(toUserFacingError("unsupported_change", session.correlationId));
        }
        const proposal = requestClarification(session.proposal, clarification);
        return ok({ ...session, proposal });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    answerClarification(session, answer) {
      try {
        if (!session.proposal) {
          return fail(toUserFacingError("unsupported_change", session.correlationId));
        }
        const proposal = answerClarification(session.proposal, answer);
        return ok({ ...session, proposal });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    markAwaitingApproval(session) {
      try {
        if (!session.proposal) {
          return fail(toUserFacingError("unsupported_change", session.correlationId));
        }
        let proposal: RevisionProposal = session.proposal;
        if (proposal.status === "draft" || proposal.status === "preview_ready") {
          proposal = applyProposalAction(proposal, "await_approval");
        } else if (proposal.status === "needs_clarification") {
          if (!proposal.clarificationAnswer) {
            return fail(toUserFacingError("unsupported_change", session.correlationId, ["clarify_first"], false));
          }
          proposal = applyProposalAction(proposal, "await_approval");
        } else if (proposal.status !== "awaiting_approval") {
          return fail(toUserFacingError("unsupported_change", session.correlationId));
        }
        return ok({ ...session, proposal });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    async approveProposal(session) {
      const voiceOk = revalidateVoice(session);
      if (!voiceOk.ok) return fail(voiceOk.error!);
      if (!session.proposal) {
        return fail(toUserFacingError("unsupported_change", session.correlationId));
      }
      if (!session.melodyRef || !session.lyricsRef) {
        return fail(toUserFacingError("unsupported_change", session.correlationId, ["set_alignment"], false));
      }
      try {
        const capability = await backend.capability();
        let proposal = resolveCapabilityOrUnsupported(session.proposal, {
          supportsPreview: capability.supportsPreview,
          supportsSegmentEdit: capability.supportsSegmentEdit,
        });
        if (proposal.status === "unsupported") {
          return fail(
            toUserFacingError("unsupported_change", session.correlationId, ["regenerate_all"], false),
          );
        }
        // Explicit awaiting_approval required — no auto-promote from needs_clarification/draft.
        proposal = approveProposal(proposal);

        const wantsSegment = proposal.capabilityRequired.includes("supportsSegmentEdit");
        const kind =
          wantsSegment && capability.supportsSegmentEdit
            ? "segment_edit"
            : "full"; // regenerate-all path when segment not required or not supported handled above

        const job = await backend.createJob({
          voiceId: session.voice!.id,
          melodyRef: session.melodyRef,
          lyricsRef: session.lyricsRef,
          kind,
        });
        return ok({
          session: {
            ...session,
            proposal,
            activeJobId: job.id,
            activeJobKind: job.kind,
            pendingRevisionJobId: job.id,
          },
          job,
        });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    selectActive(session, id) {
      try {
        if (!session.graph) return fail(toUserFacingError("unsupported_change", session.correlationId));
        return ok({ ...session, graph: selectActive(session.graph, id) });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },

    abCompare(session, a, b) {
      try {
        if (!session.graph) return fail(toUserFacingError("unsupported_change", session.correlationId));
        const cmp = abCompare(session.graph, a, b);
        return ok({ a, b, artifactRefs: [cmp.a.artifactRef, cmp.b.artifactRef] });
      } catch (err) {
        return fail(mapCaught(err, session.correlationId));
      }
    },
  };
}
