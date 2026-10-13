// ports — Studio application seams (alpha-adk #51). Domain does not import adapters.

import type { VoiceProfile, VoiceUsageScope } from "../domain/studio-voice-profile.js";
import type { RevisionProposal } from "../domain/studio-proposal.js";
import type { VersionGraph, StudioVersionId } from "../domain/studio-version.js";
import type { UserFacingError } from "../domain/studio-error.js";
import type { MelodyCatalogItem, MelodyLyricsAlignment } from "../domain/studio-melody.js";

export type SingingJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SingingCapability {
  supportsPreview: boolean;
  supportsSegmentEdit: boolean;
  maxDurationSec: number;
  languages: string[];
  failureCodes: string[];
}

export interface SingingJobView {
  id: string;
  state: SingingJobState;
  artifactRef?: string;
  failureCode?: string;
  kind: "full" | "preview" | "segment_edit";
}

export interface SingingBackendPort {
  capability(): Promise<SingingCapability>;
  createJob(input: {
    voiceId: string;
    melodyRef: string;
    lyricsRef: string;
    kind?: "full" | "preview" | "segment_edit";
  }): Promise<SingingJobView>;
  status(jobId: string): Promise<SingingJobView>;
  cancel(jobId: string): Promise<SingingJobView>;
}

export interface StudioSession {
  correlationId: string;
  voice?: VoiceProfile;
  melodyRef?: string;
  lyricsRef?: string;
  alignment?: MelodyLyricsAlignment;
  graph?: VersionGraph;
  proposal?: RevisionProposal;
  /** When set, refreshJob may attach a revision only for this approved proposal job. */
  pendingRevisionJobId?: string;
  activeJobId?: string;
  activeJobKind?: SingingJobView["kind"];
}

export interface StudioAppResult<T> {
  ok: boolean;
  value?: T;
  error?: UserFacingError;
}

export interface StudioServicePort {
  prepareVoice(
    session: StudioSession,
    rawVoice: unknown,
    scopes?: VoiceUsageScope[],
  ): StudioAppResult<StudioSession>;
  setAlignment(session: StudioSession, alignment: unknown): StudioAppResult<StudioSession>;
  listMelodyCatalog(items: unknown[]): StudioAppResult<MelodyCatalogItem[]>;
  startGeneration(session: StudioSession): Promise<StudioAppResult<{ session: StudioSession; job: SingingJobView }>>;
  refreshJob(session: StudioSession): Promise<StudioAppResult<{ session: StudioSession; job: SingingJobView }>>;
  resumeAfterRestart(session: StudioSession): Promise<StudioAppResult<{ session: StudioSession; job: SingingJobView }>>;
  openProposal(
    session: StudioSession,
    proposal: Omit<RevisionProposal, "status" | "newVersionId" | "correlationId" | "clarification" | "clarificationAnswer">,
  ): StudioAppResult<StudioSession>;
  requestClarification(
    session: StudioSession,
    clarification: { question: string; choices: string[] },
  ): StudioAppResult<StudioSession>;
  answerClarification(session: StudioSession, answer: string): StudioAppResult<StudioSession>;
  markAwaitingApproval(session: StudioSession): StudioAppResult<StudioSession>;
  approveProposal(session: StudioSession): Promise<StudioAppResult<{ session: StudioSession; job?: SingingJobView }>>;
  selectActive(session: StudioSession, id: StudioVersionId): StudioAppResult<StudioSession>;
  abCompare(session: StudioSession, a: StudioVersionId, b: StudioVersionId): StudioAppResult<{ a: StudioVersionId; b: StudioVersionId; artifactRefs: [string, string] }>;
}
