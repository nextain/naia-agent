export interface ProactiveScheduler {
  now(): number;
  schedule(delayMs: number, run: () => void | Promise<void>): () => void;
}

export interface DjContextSnapshot {
  readonly localTime: { readonly iso: string; readonly timezone: string; readonly source: "configured" };
  readonly weather?: {
    readonly code: number;
    readonly tempC: number;
    readonly observedAt: string;
    readonly source: "open-meteo";
  };
  readonly moodActivity?: {
    readonly quote: string;
    readonly sessionId: string;
    readonly statedAt: string;
  };
  readonly nowPlaying?: {
    readonly videoId: string;
    readonly title: string;
    readonly source: "bgm-player";
  };
  readonly preferences: readonly {
    readonly text: string;
    readonly source: "user-memory";
    readonly confidence: "explicit";
  }[];
}

export interface PersonalRadioDjConfig {
  readonly sessionId: string;
  readonly idleMs: number;
  readonly djIntervalMs: number;
  readonly timezone: string;
  readonly weatherLocation?: { readonly latitude: number; readonly longitude: number; readonly consented: true };
  readonly bgmAutoPlayOptIn: boolean;
}

export interface RadioDjBgmPort {
  capabilities(): { readonly ready: boolean; readonly next: boolean };
  searchAndPlay(
    query: string,
    opts: { readonly requestId: string; readonly activityId: string; readonly signal?: AbortSignal },
  ): Promise<
    | { readonly ok: true; readonly videoId: string; readonly title: string }
    | { readonly ok: false; readonly reason: string }
  >;
  next(opts: { readonly requestId: string; readonly activityId: string; readonly signal?: AbortSignal }): Promise<
    | { readonly ok: true; readonly videoId?: string; readonly title?: string }
    | { readonly ok: false; readonly reason: string }
  >;
  stop(opts: { readonly requestId: string; readonly activityId: string }): Promise<{ readonly ok: boolean }>;
  status(): Promise<{ readonly videoId: string; readonly title: string } | undefined>;
}

export interface ActivitySpeechPort {
  open(input: {
    readonly sessionId: string;
    readonly activityId: string;
    readonly requestId: string;
    readonly profileGeneration: number;
  }): void;
  speak(input: {
    readonly sessionId: string;
    readonly activityId: string;
    readonly text: string;
    readonly sourceUris?: readonly string[];
  }): Promise<"completed" | "cancelled">;
  interrupt(activityId: string): void;
  close(activityId: string, reason: "finished" | "cancelled"): void;
}

export type RadioDjSpeechPort = ActivitySpeechPort;
export type ExhibitionSpeechPort = ActivitySpeechPort;
export type ExhibitionScheduler = ProactiveScheduler;

export interface ExhibitionProfileConfig {
  readonly sessionId: string;
  readonly knowledgeScope: string;
  readonly idleMs: number;
  readonly introIntervalMs: number;
}

export interface ExhibitionIntroItem {
  readonly itemId: string;
  readonly text: string;
  readonly sourceUris: readonly string[];
}

export interface ExhibitionResumeBinding {
  readonly sessionId: string;
  readonly activityId: string;
  readonly profileGeneration: number;
  readonly yieldGeneration: number;
  readonly resumeToken: string;
}

export type SpeechProfileConfig =
  | { readonly kind: "disabled"; readonly sessionId: string }
  | { readonly kind: "personal_radio_dj"; readonly config: PersonalRadioDjConfig }
  | { readonly kind: "exhibition_intro"; readonly config: ExhibitionProfileConfig };

export interface YieldSpeechResult {
  readonly ok: boolean;
  readonly binding?: ExhibitionResumeBinding;
}
