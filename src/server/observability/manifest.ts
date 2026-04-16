export type Component = 'prometheus' | 'alloy'

export interface BinaryTarget {
  component: Component
  version: string
  url: string
  sha256: string
  /** Relative path inside the extracted archive to the actual binary. */
  executableRelPath: string
  /** tar.gz or zip — determines extraction strategy. */
  archiveKind: 'tar.gz' | 'zip'
}

/**
 * Pinned versions and checksums. Update in lockstep with the binary-manager
 * tests. Checksums MUST be verified against official releases before merging.
 *
 * Prometheus releases: https://github.com/prometheus/prometheus/releases
 * Alloy releases:      https://github.com/grafana/alloy/releases
 *
 * NOTE: sha256 values below are placeholders — the implementer MUST replace
 * them with the real checksums from the release `sha256sums.txt` files before
 * enabling telemetry in production. The binary-manager test asserts format
 * (64 hex chars) but the real download path will fail if these don't match.
 */
export const MANIFEST = {
  prometheus: {
    version: '2.54.1',
    variants: {
      'darwin-arm64': { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      'darwin-x64':   { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      'linux-arm64':  { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      'linux-x64':    { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
    },
  },
  alloy: {
    version: '1.5.0',
    variants: {
      'darwin-arm64': { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      'darwin-x64':   { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      'linux-arm64':  { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      'linux-x64':    { sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
    },
  },
} as const

type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64'

const ARCH_MAP: Record<string, string> = { arm64: 'arm64', x64: 'amd64' }
const OS_MAP:   Record<string, string> = { darwin: 'darwin', linux: 'linux' }

function variantKey(os: string, arch: string): PlatformKey {
  const mappedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!mappedArch) throw new Error(`telemetry not supported on arch=${arch}`)
  if (os !== 'darwin' && os !== 'linux') throw new Error(`telemetry not supported on os=${os}`)
  return `${os}-${mappedArch}` as PlatformKey
}

export function resolveBinaryTarget(component: Component, os: string, arch: string): BinaryTarget {
  const key = variantKey(os, arch)
  if (component === 'prometheus') {
    const v = MANIFEST.prometheus.version
    const promOs = OS_MAP[os]
    const promArch = ARCH_MAP[arch]
    const dirName = `prometheus-${v}.${promOs}-${promArch}`
    return {
      component,
      version: v,
      url: `https://github.com/prometheus/prometheus/releases/download/v${v}/${dirName}.tar.gz`,
      sha256: MANIFEST.prometheus.variants[key].sha256,
      executableRelPath: `${dirName}/prometheus`,
      archiveKind: 'tar.gz',
    }
  }
  const v = MANIFEST.alloy.version
  const alloyOs = OS_MAP[os]
  const alloyArch = ARCH_MAP[arch]
  return {
    component,
    version: v,
    url: `https://github.com/grafana/alloy/releases/download/v${v}/alloy-${alloyOs}-${alloyArch}.zip`,
    sha256: MANIFEST.alloy.variants[key].sha256,
    executableRelPath: `alloy-${alloyOs}-${alloyArch}`,
    archiveKind: 'zip',
  }
}
