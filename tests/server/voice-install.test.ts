import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { installModel, manifest, modelInstalled, voiceModelPath } from '../../bin/voice/model.js'
import { run } from '../../bin/tinstar/voice.js'

let root = ''
const bytes = Buffer.from('A tiny test model artifact')
const original = structuredClone(manifest)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-install-'))
  vi.stubEnv('TINSTAR_CONFIG_HOME', root)
  manifest.files = { 'onnx/test-model.onnx': createHash('sha256').update(bytes).digest('hex') }
  manifest.directory = 'test-english-model'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
})
afterEach(async () => {
  Object.assign(manifest, original)
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
describe('packaged voice installer', () => {
  it('downloads verified publisher artifacts and reuses the installed model', async () => {
    expect(await modelInstalled(root)).toBe(false)
    expect(await installModel(root)).toBe(voiceModelPath(root))
    expect(await modelInstalled(root)).toBe(true)
    expect(await readFile(join(voiceModelPath(root), 'onnx/test-model.onnx'))).toEqual(bytes)
    await installModel(root)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(`https://huggingface.co/Xenova/whisper-tiny.en/resolve/${manifest.revision}/`)
    expect(await readdir(join(root, 'voice'))).toEqual([manifest.directory])
  })
  it('rejects corrupt downloads, cleans staging and supports a normal retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('corrupted'))
    await expect(installModel(root)).rejects.toThrow('corrupt')
    expect(await readdir(join(root, 'voice'))).toEqual([])
    await installModel(root)
    expect(await modelInstalled(root)).toBe(true)
  })
  it('repairs a corrupted installed cache with the same install command', async () => {
    await installModel(root)
    await writeFile(join(voiceModelPath(root), 'onnx/test-model.onnx'), 'damaged model')
    expect(await modelInstalled(root)).toBe(false)
    await installModel(root)
    expect(await modelInstalled(root)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('leaves unconfigured installs alone, and upgrades previously enabled voice without an external script', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await run(['upgrade'])
    expect(fetch).not.toHaveBeenCalled()
    await run(['install'])
    manifest.directory = 'next-test-english-model'
    await run(['upgrade'])
    expect(await modelInstalled(root)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
