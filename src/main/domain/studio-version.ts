// domain — Studio VersionGraph (alpha-adk #51 / FE-NS-011 / REQ-NS-009,015)
// original immutable; agent owns refs only (no audio bytes).

export type StudioVersionId = string;

export interface StudioVersionNode {
  id: StudioVersionId;
  artifactRef: string;
  /** parent version id; null for original */
  parentId: string | null;
  createdAt: string;
  label?: string;
}

export interface VersionGraph {
  originalId: StudioVersionId;
  activeId: StudioVersionId;
  nodes: Record<StudioVersionId, StudioVersionNode>;
}

export class VersionGraphError extends Error {
  constructor(readonly code: "original_immutable" | "unknown_version" | "orphan" | "same_ab" | "invalid") {
    super(code);
    this.name = "VersionGraphError";
  }
}

export function createVersionGraph(original: {
  id: StudioVersionId;
  artifactRef: string;
  createdAt?: string;
}): VersionGraph {
  if (!original.id || !original.artifactRef) throw new VersionGraphError("invalid");
  const node: StudioVersionNode = {
    id: original.id,
    artifactRef: original.artifactRef,
    parentId: null,
    createdAt: original.createdAt ?? new Date().toISOString(),
    label: "original",
  };
  return {
    originalId: original.id,
    activeId: original.id,
    nodes: { [original.id]: node },
  };
}

/** Add a revision. Never mutates original node fields. */
export function addRevision(
  graph: VersionGraph,
  revision: { id: StudioVersionId; artifactRef: string; parentId: StudioVersionId; createdAt?: string; label?: string },
): VersionGraph {
  if (revision.id === graph.originalId) throw new VersionGraphError("original_immutable");
  if (graph.nodes[revision.id]) throw new VersionGraphError("invalid");
  if (!graph.nodes[revision.parentId]) throw new VersionGraphError("orphan");
  if (!revision.artifactRef) throw new VersionGraphError("invalid");
  const node: StudioVersionNode = {
    id: revision.id,
    artifactRef: revision.artifactRef,
    parentId: revision.parentId,
    createdAt: revision.createdAt ?? new Date().toISOString(),
    label: revision.label,
  };
  return {
    ...graph,
    nodes: { ...graph.nodes, [revision.id]: node },
  };
}

export function selectActive(graph: VersionGraph, id: StudioVersionId): VersionGraph {
  if (!graph.nodes[id]) throw new VersionGraphError("unknown_version");
  return { ...graph, activeId: id };
}

/** Mutating original artifactRef is forbidden. */
export function replaceOriginalArtifact(_graph: VersionGraph, _artifactRef: string): never {
  throw new VersionGraphError("original_immutable");
}

export function abCompare(graph: VersionGraph, a: StudioVersionId, b: StudioVersionId): {
  a: StudioVersionNode;
  b: StudioVersionNode;
} {
  if (a === b) throw new VersionGraphError("same_ab");
  const left = graph.nodes[a];
  const right = graph.nodes[b];
  if (!left || !right) throw new VersionGraphError("unknown_version");
  return { a: left, b: right };
}

/** Guard: serialized graph must not embed audio bytes fields. */
export function assertGraphHasNoAudioBytes(graph: VersionGraph): void {
  const text = JSON.stringify(graph);
  if (/"audio"|"bytes"|"wav"|"pcm"/i.test(text)) {
    throw new VersionGraphError("invalid");
  }
}
