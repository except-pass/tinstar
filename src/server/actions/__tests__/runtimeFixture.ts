import { execFileSync } from 'node:child_process'
import { open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtimeRoot = join(tmpdir(), 'tinstar-shared-action-runtime')
const stampPath = join(tmpdir(), 'tinstar-shared-action-runtime.stamp')
const lockPath = join(tmpdir(), 'tinstar-shared-action-runtime.lock')

function expectedStamp() {
  const info = statSync(process.execPath)
  return `${process.execPath}\n${info.size}\n${Math.trunc(info.mtimeMs)}\n`
}

async function staged() {
  try { return (await readFile(stampPath, 'utf8')) === expectedStamp() } catch { return false }
}

async function releaseStaleLock() {
  try {
    const owner = Number(await readFile(lockPath, 'utf8'))
    if (!Number.isInteger(owner) || owner <= 0) return
    try { process.kill(owner, 0) } catch (error) {
      // A crashed stager must not leave every later worker waiting on the lock.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') await unlink(lockPath).catch(() => {})
    }
  } catch { /* The lock disappeared, or the owner has not written its pid yet. */ }
}

/** One staged Node/prlimit tree per machine, shared by every vitest worker.
 * Copying it per file is about 250MB and stalls the fsynced action tests when
 * the suite runs in parallel. Callers must not delete the returned directory. */
export async function stageTestRuntime() {
  if (await staged()) return runtimeRoot
  const deadline = Date.now() + 60_000
  for (;;) {
    if (await staged()) return runtimeRoot
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await releaseStaleLock()
      if (Date.now() > deadline) throw new Error('Timed out waiting for the shared action test runtime')
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }
    try {
      await handle.writeFile(String(process.pid))
      if (!(await staged())) {
        await rm(runtimeRoot, { recursive: true, force: true })
        execFileSync(process.execPath, [join(process.cwd(), 'bin/tinstar-stage-action-runtime.js'), runtimeRoot], { env: {} })
        await writeFile(stampPath, expectedStamp())
      }
      return runtimeRoot
    } finally {
      await handle.close()
      await unlink(lockPath).catch(() => {})
    }
  }
}
