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

  return {
    name: pkg.name,
    version: pkg.version,
    manifest: m as unknown as PluginManifest,
  }
}
