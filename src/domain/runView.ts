export const DEFAULT_RUN_VIEW = 'run-workspace'

/** Resolve which registered widget type renders a run's canvas node.
 *  `run.view` wins when set AND registered; otherwise the default run-workspace.
 *  A run.view naming an unregistered type (e.g. a disabled plugin) falls back to
 *  the default so the session is never unreachable. */
export function resolveRunViewType(
  run: { view?: string },
  isRegistered: (widgetType: string) => boolean,
): string {
  if (run.view && isRegistered(run.view)) return run.view
  return DEFAULT_RUN_VIEW
}
