/**
 * Per-action policy enforcement for discovery. Reuses PolicyConfig (see
 * ../engine/config.ts) rather than inventing a parallel policy system —
 * `irreversibleTargets` was added there specifically for this. What's new
 * here is matching it against a LIVE ref descriptor, since discovery has no
 * artifact step.risk to key off (that's assigned later, by the compiler):
 * the only thing to match against is the accessible role/name the model's
 * chosen element actually has right now.
 */
import type { IrreversibleTargetPattern, PolicyConfig } from "../engine/config.js";
import type { DiscoveryAction, RefDescriptor } from "../schema/discovery.js";

export type DiscoveryPolicyVerdict = { allowed: true } | { allowed: false; reason: string };

function matchesPattern(descriptor: RefDescriptor, pattern: IrreversibleTargetPattern): boolean {
  if (pattern.role && pattern.role !== descriptor.role) {
    return false;
  }
  if (pattern.namePattern) {
    const name = descriptor.name ?? "";
    if (!new RegExp(pattern.namePattern).test(name)) {
      return false;
    }
  }
  return true;
}

/**
 * Checked before every ref-targeting action (click/fill/select/extract) —
 * extract is included even though it's read-only because a target that
 * matches an irreversible pattern is worth refusing regardless of the verb;
 * in practice only click on a declared irreversible control (e.g. "Close
 * Account") is expected to ever match. `navigate`/`done`/`stuck` never
 * target a ref and so are never blockable here.
 */
export function checkDiscoveryAction(
  action: DiscoveryAction,
  descriptor: RefDescriptor | undefined,
  policy: PolicyConfig,
): DiscoveryPolicyVerdict {
  if (!("ref" in action) || !descriptor) {
    return { allowed: true };
  }
  if (policy.confirmIrreversible) {
    return { allowed: true };
  }
  const targets = policy.irreversibleTargets ?? [];
  const match = targets.find((pattern) => matchesPattern(descriptor, pattern));
  if (!match) {
    return { allowed: true };
  }
  const label = descriptor.name ? `${descriptor.role} "${descriptor.name}"` : descriptor.role;
  return {
    allowed: false,
    reason: `${label} matches a declared irreversible target and policy.confirmIrreversible is not set; refusing to ${action.action} it unattended`,
  };
}
