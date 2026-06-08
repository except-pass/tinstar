import type { PluginManifest } from '@tinstar/plugin-api'

export interface ParsedManifest {
  name: string
  version: string
  manifest: PluginManifest
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

function validateWidgetContribution(w: Record<string, unknown>, pluginName: string, idx: number): void {
  const where = `${pluginName}: contributes.widgets[${idx}]`
  if (typeof w.type !== 'string' || w.type === '') {
    throw new ManifestError(`${where}: type must be a non-empty string`)
  }
  if (typeof w.label !== 'string' || w.label === '') {
    throw new ManifestError(`${where}: label must be a non-empty string`)
  }
  if (w.singleton !== undefined && typeof w.singleton !== 'boolean') {
    throw new ManifestError(`${where}: singleton must be a boolean if present`)
  }
  if (w.spawn !== undefined && w.spawn !== 'palette' && w.spawn !== 'palette+context') {
    throw new ManifestError(`${where}: spawn must be 'palette' or 'palette+context'`)
  }
  if (w.description !== undefined && typeof w.description !== 'string') {
    throw new ManifestError(`${where}: description must be a string if present`)
  }
  if (w.icon !== undefined && typeof w.icon !== 'string') {
    throw new ManifestError(`${where}: icon must be a string path if present`)
  }
  if (w.defaultSize !== undefined) {
    const ds = w.defaultSize as Record<string, unknown>
    if (!ds || typeof ds !== 'object' || typeof ds.width !== 'number' || typeof ds.height !== 'number') {
      throw new ManifestError(`${where}: defaultSize must be { width: number, height: number }`)
    }
  }
  if (w.creator !== undefined && w.creator !== 'standalone' && w.creator !== 'session-backed') {
    throw new ManifestError(`${where}: creator must be 'standalone' or 'session-backed' if present`)
  }
  if (w.capabilities !== undefined && !isStringArray(w.capabilities)) {
    throw new ManifestError(`${where}: capabilities must be an array of strings if present`)
  }
  if (w.tags !== undefined && !isStringArray(w.tags)) {
    throw new ManifestError(`${where}: tags must be an array of strings if present`)
  }
  if (w.snappable !== undefined && typeof w.snappable !== 'boolean') {
    throw new ManifestError(`${where}: snappable must be a boolean if present`)
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

export function parseManifest(pkgJson: unknown): ParsedManifest {
  if (!pkgJson || typeof pkgJson !== 'object') {
    throw new ManifestError('package.json is not an object')
  }
  const pkg = pkgJson as Record<string, unknown>

  if (typeof pkg.name !== 'string' || pkg.name === '') {
    throw new ManifestError('package.json: name must be a non-empty string')
  }
  if (typeof pkg.version !== 'string') {
    throw new ManifestError(`${pkg.name}: package.json version must be a string`)
  }

  const tinstar = pkg.tinstar
  if (!tinstar || typeof tinstar !== 'object') {
    throw new ManifestError(`${pkg.name}: missing tinstar manifest in package.json`)
  }
  const m = tinstar as Record<string, unknown>

  if (m.apiVersion !== '5') {
    throw new ManifestError(`${pkg.name}: incompatible apiVersion ${String(m.apiVersion)}, expected 5`)
  }
  if (typeof m.displayName !== 'string' || m.displayName === '') {
    throw new ManifestError(`${pkg.name}: tinstar.displayName must be a non-empty string`)
  }

  const contributes = m.contributes as { widgets?: unknown[] } | undefined
  if (contributes?.widgets) {
    if (!Array.isArray(contributes.widgets)) {
      throw new ManifestError(`${pkg.name}: contributes.widgets must be an array`)
    }
    contributes.widgets.forEach((w, i) => {
      if (!w || typeof w !== 'object') {
        throw new ManifestError(`${pkg.name}: contributes.widgets[${i}] must be an object`)
      }
      validateWidgetContribution(w as Record<string, unknown>, String(pkg.name), i)
    })
  }

  return {
    name: pkg.name,
    version: pkg.version,
    manifest: m as unknown as PluginManifest,
  }
}
