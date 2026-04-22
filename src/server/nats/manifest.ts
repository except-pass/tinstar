import type { BinaryTarget } from '../infra/types.js'

const VERSION = '2.10.24'

const CHECKSUMS: Record<string, string> = {
  'darwin-arm64': 'e7cba91a2388ac60b487d225908dd42a4490df5cf6def929bc813dbd83dccf11',
  'darwin-x64':   'bf2503540b12a2550b36323918d00d0a8578c40781609000ce219d0ea3710ea2',
  'linux-arm64':  'a4ae6c46ef545a13a3214bc35696b2806e05b60742f7ed5b2082d3c2f5af854f',
  'linux-x64':    'ee6500f364e3a741b496ae0296c04f2a9d53bbaabac457104ac74596b4a59d85',
}

const ARCH_MAP: Record<string, string> = { arm64: 'arm64', x64: 'amd64' }

type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64'

function variantKey(os: string, arch: string): PlatformKey {
  const mappedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!mappedArch) throw new Error(`nats-server not supported on arch=${arch}`)
  if (os !== 'darwin' && os !== 'linux') throw new Error(`nats-server not supported on os=${os}`)
  return `${os}-${mappedArch}` as PlatformKey
}

export function resolveNatsTarget(os: string, arch: string): BinaryTarget {
  const key = variantKey(os, arch)
  const natsArch = ARCH_MAP[arch] ?? arch
  const ext = os === 'darwin' ? 'zip' : 'tar.gz'
  const dirName = `nats-server-v${VERSION}-${os}-${natsArch}`
  return {
    component: 'nats',
    version: VERSION,
    url: `https://github.com/nats-io/nats-server/releases/download/v${VERSION}/${dirName}.${ext}`,
    sha256: CHECKSUMS[key],
    executableRelPath: `${dirName}/nats-server`,
    archiveKind: ext,
  }
}
