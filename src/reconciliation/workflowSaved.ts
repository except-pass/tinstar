/** Local view invalidation after a confirmed or partial workflow response.
 * Not a delivery channel: consumers reconcile current authoritative records. */
export const WORKFLOW_SAVED = 'tinstar:workflow-saved'
export const workflowSaved = () => window.dispatchEvent(new Event(WORKFLOW_SAVED))
