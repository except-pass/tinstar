export interface TemplateVars {
  task?: string
  taskId?: string
  sessionId?: string
  orchestrator?: string
  worker?: string
  [key: string]: string | undefined
}

/**
 * Interpolate Jinja-style {{variable}} placeholders in a template string.
 * Unknown variables are left as-is.
 */
export function interpolateTemplate(template: string | undefined, vars: TemplateVars): string | undefined {
  if (!template) return template

  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const value = vars[varName]
    return value !== undefined ? value : match
  })
}

/**
 * Interpolate all string fields in a session config object.
 */
export function interpolateSessionConfig<T extends Record<string, unknown>>(
  config: T,
  vars: TemplateVars
): T {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      result[key] = interpolateTemplate(value, vars)
    } else {
      result[key] = value
    }
  }

  return result as T
}
