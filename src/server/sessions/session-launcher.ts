// Reusable managed-session launch, with compensation (plan U6, KTD11).
//
// WHY THIS EXISTS. Creating a managed session is not one call — it is a port
// claim, a session directory, a tmux server, a ttyd, a Run record, and a ready
// queue entry, in that order, each of which can fail. Every one of those failures
// used to be handled (or not) inline in `routes.ts`, where the recovery was
// whatever the surrounding `try` happened to cover. U6 needs the same sequence for
// a background refresh worker, and a half-created worker is worse than none: it
// holds a port, it shows up as a run, and nothing owns tearing it down.
//
// So the sequence is expressed as ORDERED STEPS WITH INVERSES. The launcher runs
// them forward and, on any failure, runs the inverses of the steps that DID
// succeed, in reverse. That is the whole mechanism, and it is what makes "failure
// after each provisioning stage compensates resources" a property you can test
// once per stage rather than a claim about a `try` block.
//
// STATES. `reserved` (nothing exists yet), `provisioning` (steps are running),
// `ready` (everything succeeded), `failed` (compensated), `retired` (a ready
// session was torn down deliberately). The launcher REPORTS these through
// `onStage`; it does not own a durable table of them, because its two callers
// already have one each — a refresh job's `dispatch`, and the session record's own
// `state`. A third would be a third thing to keep in step.
//
// Server-only and React-free.

import { log } from '../logger'

/** Where a launch stands. */
export type LaunchStage = 'reserved' | 'provisioning' | 'ready' | 'failed' | 'retired'

/**
 * One provisioning step and its inverse.
 *
 * `compensate` is optional because some steps genuinely create nothing to undo
 * (a validation, a lookup). It is NOT optional for anything that claims a
 * resource, and a step that omits it there is the bug this interface exists to
 * make visible in review.
 */
export interface LaunchStep {
  /** Short name, used in the stage report and in the failure message. */
  name: string
  run(): Promise<void>
  compensate?(): Promise<void>
}

export interface LaunchOutcome {
  ok: boolean
  /** Steps that completed. */
  completed: string[]
  /** The step that threw, when one did. */
  failedAt?: string
  message?: string
  /** Steps whose inverse ran, in the order they ran. */
  compensated: string[]
  /** Steps whose inverse ITSELF threw. Reported rather than swallowed: a resource
   *  that could not be released is exactly the thing a human has to know about. */
  leaked: { step: string; message: string }[]
}

/**
 * Run a launch sequence, unwinding on failure.
 *
 * Returns rather than throws. A launch failure is an ordinary outcome for the
 * caller — a refresh job fails, a route answers 503 — and making it an exception
 * would put the compensation report somewhere a `catch` has to dig it out of.
 */
export async function runLaunchSteps(
  steps: readonly LaunchStep[],
  onStage?: (stage: LaunchStage, detail?: string) => void,
): Promise<LaunchOutcome> {
  const outcome: LaunchOutcome = { ok: false, completed: [], compensated: [], leaked: [] }
  onStage?.('reserved')
  const done: LaunchStep[] = []
  for (const step of steps) {
    onStage?.('provisioning', step.name)
    try {
      await step.run()
    } catch (err) {
      outcome.failedAt = step.name
      outcome.message = (err as Error).message
      // Reverse order: the last thing created is the first thing released, so a
      // step's inverse never runs while something built on top of it still exists.
      for (const prior of [...done].reverse()) {
        if (!prior.compensate) continue
        try {
          await prior.compensate()
          outcome.compensated.push(prior.name)
        } catch (undoErr) {
          outcome.leaked.push({ step: prior.name, message: (undoErr as Error).message })
          log.warn('launcher', `could not compensate step "${prior.name}": ${(undoErr as Error).message}`)
        }
      }
      onStage?.('failed', step.name)
      return outcome
    }
    done.push(step)
    outcome.completed.push(step.name)
  }
  outcome.ok = true
  onStage?.('ready')
  return outcome
}

/**
 * A launched session's identity, returned ONLY after every step succeeded.
 *
 * `incarnation` is the launch stamp, and it is the reason restart adoption is
 * safe: a session NAME is reusable, so a coordinator that matched on the name
 * alone would adopt whatever now answers to it — including a session a human
 * created later that happens to share the name. Matching on name AND incarnation
 * means adoption only ever succeeds against the same launch.
 */
export interface SessionIncarnation {
  name: string
  incarnation: string
  port: number
}
