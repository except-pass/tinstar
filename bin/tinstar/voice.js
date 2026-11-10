import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigRoot } from '../configRoot.js'
import { installModel, modelInstalled, voiceModelPath } from '../voice/model.js'

export async function run(args = process.argv.slice(3)) {
  if (args[0] === 'upgrade') {
    // An npm update refreshes previously enabled voice installations on Mac/Linux.
    // Unconfigured clients do not download a model or run any inference.
    try { await access(join(getConfigRoot(), 'voice')) } catch { return }
  }
  if (args[0] === 'status') {
    console.log(await modelInstalled() ? `Local English voice model ready: ${voiceModelPath()}` : 'Local voice model unavailable. Run: tinstar voice install')
    return
  }
  if (args[0] !== 'install' && args[0] !== 'upgrade') throw new Error('Usage: tinstar voice install|status')
  console.log(`Local English voice model ready: ${await installModel()}`)
}
