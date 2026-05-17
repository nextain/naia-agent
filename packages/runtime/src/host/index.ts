export { createHost } from "./create-host.js";
export type { CreateHostOptions } from "./create-host.js";

// R6/SB-1 (#32, matrix §D50) — service manifest loader (pure parse/validate
// + memory-binding resolve). Concrete LLMClient construction stays host-side.
export {
  parseServiceManifest,
  resolveMemoryBinding,
  manifestBaseURLTrust,
  manifestInvalid,
  SUPPORTED_MANIFEST_MAJOR,
} from "./service-manifest.js";
export type {
  ServiceManifest,
  ManifestParseResult,
  AlphaMemoryFactory,
} from "./service-manifest.js";
