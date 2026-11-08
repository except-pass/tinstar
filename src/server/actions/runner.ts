import { operationSchema, type ActionCandidate, type ActionOperation } from '../../shared/actions'
import { trustedOperation } from './examples'

export const runnerStatus = 'Custom code execution unavailable: no approved distinct-identity isolation with restricted mounts and no network has been configured. Trusted simulation fixtures only.'
/** Deliberately no eval, import(source), VM, shell, subprocess, filesystem client,
 * network client or credentials. This is a fixture interpreter, NOT a sandbox.
 * A separately reviewed OS runner is required before running installed source. */
export function simulateRunner(candidate: ActionCandidate, head: string, signal: AbortSignal): ActionOperation {
  signal.throwIfAborted()
  const operation = trustedOperation(candidate, head)
  if (!operation) throw new Error(runnerStatus)
  if (Buffer.byteLength(JSON.stringify(operation)) > candidate.manifest.limits.outputBytes) throw new Error('Runner output limit exceeded')
  return operationSchema.parse(operation)
}
