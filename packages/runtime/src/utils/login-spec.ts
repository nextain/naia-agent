// `naia-agent login` role-spec parser — pure + unit-tested (extracted from
// bin so the slice gate's unit-test requirement is met and the write-time
// secret rejection is verifiable).
//
// Spec format (| is the field delimiter — URLs/models must not contain |):
//   main/sub:  provider|baseUrl|model[|apiKeyRef]
//   embedded:  provider|baseUrl|model|dims[|apiKeyRef]
//
// `apiKeyRef` is a NAME (env var / OS-keychain entry), never a secret
// value. The login WRITE path is the prevention boundary: a raw-credential
// in the apiKeyRef slot is rejected here so it never reaches the
// git-tracked llm.json (read-side scan is detection, not prevention).

import { RAW_SECRET_VALUE } from "./naia-settings.js";

export type ParsedRole = {
  provider: string;
  baseUrl: string;
  model: string;
  dims?: number;
  apiKeyRef?: string;
};

export type ParseRoleResult =
  | { ok: true; role: ParsedRole }
  | { ok: false; err: string };

function rejectIfSecretish(ref: string): string | null {
  if (/\s/.test(ref)) return `apiKeyRef must be a name (no whitespace), got "${ref}"`;
  if (RAW_SECRET_VALUE.some((re) => re.test(ref))) {
    return `apiKeyRef looks like a RAW SECRET — pass a name (env var / keychain entry), not the key itself`;
  }
  return null;
}

export function parseRoleSpec(spec: string, embedded: boolean): ParseRoleResult {
  const p = spec.split("|");
  const min = embedded ? 4 : 3;
  if (p.length < min || !p[0] || !p[1] || !p[2]) {
    return {
      ok: false,
      err: `spec must be provider|baseUrl|model${embedded ? "|dims[|apiKeyRef]" : "[|apiKeyRef]"} (got "${spec}")`,
    };
  }
  const role: ParsedRole = { provider: p[0], baseUrl: p[1], model: p[2] };
  let refField: string | undefined;
  if (embedded) {
    const d = Number(p[3]);
    if (!Number.isInteger(d) || d <= 0) {
      return { ok: false, err: `embedded dims must be a positive integer (got "${p[3]}")` };
    }
    role.dims = d;
    refField = p[4];
  } else {
    refField = p[3];
  }
  if (refField) {
    const bad = rejectIfSecretish(refField);
    if (bad) return { ok: false, err: bad };
    role.apiKeyRef = refField;
  }
  return { ok: true, role };
}
