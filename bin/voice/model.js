import { readFile, mkdir, mkdtemp, rm, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { getConfigRoot } from '../configRoot.js'

export const manifest = JSON.parse(await readFile(new URL('./model.json', import.meta.url), 'utf8'))
export const voiceModelPath = (root = getConfigRoot()) => join(root, 'voice', manifest.directory)
export async function modelInstalled(root = getConfigRoot()) {
  try {
    // Installation/status checks can repair a damaged cache. Inference only
    // checks availability and never rehashes model files on each recording.
    for (const [file, expected] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(voiceModelPath(root), file))
      if (createHash('sha256').update(bytes).digest('hex') !== expected) return false
    }
    return true
  }
  catch { return false }
}
/** Install assets, never inference, from the model runtime publisher. Checksums
 * prevent partial/corrupt downloads from producing silently wrong transcripts. */
export async function installModel(root = getConfigRoot()) {
  if (await modelInstalled(root)) return voiceModelPath(root)
  await mkdir(join(root, 'voice'), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(root, 'voice', '.install-'))
  try {
    for (const [file, sha256] of Object.entries(manifest.files)) {
      const response = await fetch(`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file}`, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Voice model download failed (${response.status}); rerun tinstar voice install.`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Voice model download was corrupt. Rerun tinstar voice install.')
      await mkdir(dirname(join(staging, file)), { recursive: true })
      await writeFile(join(staging, file), bytes, { mode: 0o600 })
    }
    // Repair an incomplete installation; complete concurrent installs are safe.
    if (!await modelInstalled(root)) await rm(voiceModelPath(root), { recursive: true, force: true })
    try { await rename(staging, voiceModelPath(root)) }
    catch (error) { if (!await modelInstalled(root)) throw error }
    return voiceModelPath(root)
  } finally { await rm(staging, { recursive: true, force: true }) }
}
