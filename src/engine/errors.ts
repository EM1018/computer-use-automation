/**
 * Error types thrown while resolving a step's target locator, and while
 * enforcing the automation/human mutual-exclusion guarantee on a Session.
 *
 * Two distinct failure shapes are deliberately kept apart:
 *   - AmbiguousTarget: a single strategy resolved to more than one element.
 *     This means the recorded locator itself is unsound (it was supposed to
 *     have been verified unique at record time) and is treated as an
 *     immediate hard stop — it never falls through to outcome/recoverable
 *     evaluation, because it is not a page-state question, it is a broken
 *     recording.
 *   - NoTargetFound: every strategy in the ladder matched zero elements.
 *     This DOES fall through to outcome/recoverable evaluation, because a
 *     missing element is exactly what a declared alternate page state (an
 *     outcome, or an obstruction a recoverable knows how to clear) looks
 *     like from the outside.
 */

export class AmbiguousTarget extends Error {
  readonly stepId: string;
  readonly strategyIndex: number;
  readonly matchCount: number;

  constructor(stepId: string, strategyIndex: number, matchCount: number) {
    super(
      `step "${stepId}": strategy at index ${strategyIndex} resolved to ${matchCount} elements, expected exactly 1`,
    );
    this.name = "AmbiguousTarget";
    this.stepId = stepId;
    this.strategyIndex = strategyIndex;
    this.matchCount = matchCount;
  }
}

export class NoTargetFound extends Error {
  readonly stepId: string;

  constructor(stepId: string) {
    super(`step "${stepId}": no strategy in the ladder matched any element`);
    this.name = "NoTargetFound";
    this.stepId = stepId;
  }
}

/**
 * Thrown whenever engine code attempts a browser action while the Session's
 * controller is not "automation". This is a real mutual-exclusion guarantee:
 * every action-performing code path asserts control first, unconditionally.
 */
export class ControlViolation extends Error {
  constructor(sessionId: string) {
    super(`session "${sessionId}" is not controlled by automation`);
    this.name = "ControlViolation";
  }
}

export type StepUnmetReason = "timeout" | "checkpoint_mismatch" | "no_target";

/**
 * Internal control-flow signal: a step's wait condition timed out, its
 * checkpoint didn't hold, or its target ladder was exhausted with zero
 * matches. All three are routed the same way — into outcome/recoverable
 * evaluation — because from the outside they look identical: the page
 * isn't in the state this step expected.
 */
export class StepUnmet extends Error {
  readonly reason: StepUnmetReason;
  readonly observedText: string;

  constructor(reason: StepUnmetReason, observedText: string) {
    super(`step did not meet its wait/checkpoint condition (${reason})`);
    this.name = "StepUnmet";
    this.reason = reason;
    this.observedText = observedText;
  }
}
