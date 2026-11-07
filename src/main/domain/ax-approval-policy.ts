// UC13 / FR-AX-026.3 — trusted host effects, never model-provided risk labels.
export type AxEffect =
  | "local_read" | "local_draft" | "reversible_edit"
  | "external_send" | "external_processing" | "calendar_write"
  | "permanent_delete" | "payment" | "production_change";

export type AxApproval = "allow" | "conversation" | "code" | "deny";

/** Empty/unrecognized classifications have no authority to execute. */
export function axApprovalFor(effects: readonly AxEffect[]): AxApproval {
  if (effects.length === 0) return "deny";
  let decision: AxApproval = "allow";
  for (const effect of effects) {
    switch (effect) {
      case "local_read": case "local_draft": case "reversible_edit": break;
      case "external_send": case "external_processing": case "calendar_write":
        if (decision === "allow") decision = "conversation";
        break;
      case "permanent_delete": case "payment": case "production_change":
        decision = "code";
        break;
      default: return "deny";
    }
  }
  return decision;
}
