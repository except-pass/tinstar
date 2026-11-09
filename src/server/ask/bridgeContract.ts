import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const bridgeContract = { contract_version: 1, minimum_puller_version: '6.0.0' } as const
export const bridgeHeaders = {
  'X-Tinstar-Bridge-Contract': String(bridgeContract.contract_version),
  'X-Tinstar-Minimum-Puller-Version': bridgeContract.minimum_puller_version,
}

// Missing headers identify the released 6.0.0 adapter. Keep its wire contract
// supported until an explicit retirement changes the minimum above.
export function supportedPuller(version = '6.0.0', minimum = bridgeContract.minimum_puller_version as string): boolean {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null
  const actual = parse(version), required = parse(minimum)
  if (!actual || !required) return false
  for (let i = 0; i < 3; i++) {
    if (actual[i]! !== required[i]!) return actual[i]! > required[i]!
  }
  return true
}

export async function pullerRelease() {
  // Resolve against this module, never cwd: works in src and the installed
  // dist/server bundle. Only serve code shipped in this server's package.
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'scripts/ask-puller.py'))) {
    const parent = dirname(root)
    if (parent === root) throw new Error('Packaged puller unavailable')
    root = parent
  }
  const source = await readFile(join(root, 'scripts/ask-puller.py'), 'utf8')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
  return { version, bootstrap_api: 1, sha256: createHash('sha256').update(source).digest('hex'), source }
}
