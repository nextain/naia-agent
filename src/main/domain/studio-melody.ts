// domain — Melody catalog + alignment DTO (FE-NS-010,014 / REQ-NS-014)

export type MelodyOriginType = "catalog" | "user_import" | "prepared";

export interface MelodyCatalogItem {
  id: string;
  title: string;
  originType: MelodyOriginType;
  licenseNotice: string;
  /** opaque score/timing ref — never raw MIDI bytes or absolute paths */
  opaqueScoreRef: string;
}

export interface MelodyLyricsAlignment {
  melodyRef: string;
  lyricsRef: string;
  /** opaque alignment artifact produced internally */
  alignmentRef: string;
}

export class MelodyContractError extends Error {
  constructor(readonly code: "invalid" | "absolute_path" | "raw_midi") {
    super(code);
    this.name = "MelodyContractError";
  }
}

function assertOpaqueRef(value: string, field: string): string {
  const v = value.trim();
  if (!v) throw new MelodyContractError("invalid");
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.split(/[\\/]/).includes("..")) {
    throw new MelodyContractError("absolute_path");
  }
  if (/\.mid(i)?$/i.test(v) && v.includes("/")) {
    // path-like midi file rejected; opaque keys like "score:moon-river" OK
    throw new MelodyContractError("absolute_path");
  }
  if (field === "opaqueScoreRef" && /[\x00-\x08]/.test(v)) throw new MelodyContractError("invalid");
  return v;
}

export function normalizeMelodyCatalogItem(value: unknown): MelodyCatalogItem {
  if (!value || typeof value !== "object") throw new MelodyContractError("invalid");
  const o = value as Record<string, unknown>;
  if ("midiBytes" in o || "bytes" in o || "midi" in o) throw new MelodyContractError("raw_midi");
  const originType = o.originType;
  if (originType !== "catalog" && originType !== "user_import" && originType !== "prepared") {
    throw new MelodyContractError("invalid");
  }
  return {
    id: assertOpaqueRef(String(o.id ?? ""), "id"),
    title: String(o.title ?? "").trim() || (() => { throw new MelodyContractError("invalid"); })(),
    originType,
    licenseNotice: String(o.licenseNotice ?? "").trim() || (() => { throw new MelodyContractError("invalid"); })(),
    opaqueScoreRef: assertOpaqueRef(String(o.opaqueScoreRef ?? ""), "opaqueScoreRef"),
  };
}

export function normalizeAlignment(value: unknown): MelodyLyricsAlignment {
  if (!value || typeof value !== "object") throw new MelodyContractError("invalid");
  const o = value as Record<string, unknown>;
  if ("midiBytes" in o || "bytes" in o) throw new MelodyContractError("raw_midi");
  return {
    melodyRef: assertOpaqueRef(String(o.melodyRef ?? ""), "melodyRef"),
    lyricsRef: assertOpaqueRef(String(o.lyricsRef ?? ""), "lyricsRef"),
    alignmentRef: assertOpaqueRef(String(o.alignmentRef ?? ""), "alignmentRef"),
  };
}
