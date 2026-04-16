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
 *   Checksums from: https://github.com/prometheus/prometheus/releases/download/v2.54.1/sha256sums.txt
 * Alloy releases:      https://github.com/grafana/alloy/releases
 *   Alloy does not publish a sha256sums file; values below were computed by
 *   piping each zip through sha256sum (reproducible via `curl -sSL <url> | sha256sum`).
 */
export const MANIFEST = {
  prometheus: {
    version: '2.54.1',
    variants: {
      'darwin-arm64': { sha256: 'ac80faf6bb4e135f58e7d3f2423f561286d07205a93fef2e4bf2c56ce1484038' },
      'darwin-x64':   { sha256: '841e823ddee1da5fcbce5266bd448c2511297c570a6310a7bf81b226f0def5ea' },
      'linux-arm64':  { sha256: '3d9946ca730f2679bbd63e9d40e559a0ba227a638d237e723af1a99bd7098263' },
      'linux-x64':    { sha256: '31715ef65e8a898d0f97c8c08c03b6b9afe485ac84e1698bcfec90fc6e62924f' },
    },
  },
  alloy: {
    version: '1.5.0',
    variants: {
      'darwin-arm64': { sha256: 'e98e546f549e771f2af4400990862fc19320b1dbc4227a9bb476528933440607' },
      'darwin-x64':   { sha256: '7102641591a54ae8094ed4ea1903e16cde987be2e80e54e3327dc363e9a18713' },
      'linux-arm64':  { sha256: 'c22de0b7c1fa0126fa528fb5ad078c743fb31e59f48948c12c5a7780cb465551' },
      'linux-x64':    { sha256: 'd4d5aab7bbdd16aca8f6be61e096cb8c4539d5230d2e30057e7c7b7afdc3faba' },
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
