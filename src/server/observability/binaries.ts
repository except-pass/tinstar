import { createHash } from 'node:crypto'
import { createWriteStream, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import type { BinaryTarget } from './manifest.js'
import type { DownloadProgress } from './types.js'

export interface InstallResult {
  binaryPath: string
  verifiedHash: string
}

export type ProgressFn = (p: DownloadProgress) => void

export async function installBinary(
  target: BinaryTarget,
  installRoot: string,
  onProgress?: ProgressFn,
): Promise<InstallResult> {
  const finalDir = join(installRoot, `${target.component}-${target.version}`)
  const binaryPath = join(installRoot, target.executableRelPath)

  // Cache hit: file exists + recorded hash matches.
  const hashSidecar = `${finalDir}.sha256`
  if (existsSync(binaryPath) && existsSync(hashSidecar)) {
    const recorded = readFileSync(hashSidecar, 'utf-8').trim()
    if (recorded === target.sha256) {
      return { binaryPath, verifiedHash: recorded }
    }
  }

  // Download to temp path.
  mkdirSync(installRoot, { recursive: true })
  const tmpArchive = join(installRoot, `.download-${target.component}-${Date.now()}`)
  await downloadTo(target.url, tmpArchive, target.component, onProgress)

  // Verify sha256.
  const actualHash = sha256File(tmpArchive)
  if (actualHash !== target.sha256) {
    rmSync(tmpArchive, { force: true })
    throw new Error(
      `binary checksum mismatch for ${target.component}@${target.version}: expected ${target.sha256}, got ${actualHash}`,
    )
  }

  // Extract into a staging dir, then atomically rename into place.
  const staging = join(installRoot, `.staging-${target.component}-${Date.now()}`)
  await mkdir(staging, { recursive: true })
  if (target.archiveKind === 'tar.gz') {
    await extractTarGz(tmpArchive, staging)
  } else {
    await extractZip(tmpArchive, staging)
  }
  rmSync(tmpArchive, { force: true })

  // Rename staging into installRoot preserving the archive's top-level directory.
  const entries = await readdir(staging)
  if (entries.length !== 1) {
    throw new Error(`unexpected archive layout for ${target.component}: found ${entries.length} entries at top level`)
  }
  const topLevel = entries[0]
  const stagedTop = join(staging, topLevel)
  const finalTop = join(installRoot, topLevel)
  if (existsSync(finalTop)) rmSync(finalTop, { recursive: true, force: true })
  renameSync(stagedTop, finalTop)
  rmSync(staging, { recursive: true, force: true })

  // Ensure binary is executable.
  chmodSync(binaryPath, 0o755)

  // Write sidecar for cache check.
  writeFileSync(`${finalDir}.sha256`, target.sha256)

  return { binaryPath, verifiedHash: target.sha256 }
}

function sha256File(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

async function downloadTo(url: string, dest: string, component: string, onProgress?: ProgressFn): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`)
  if (!res.body) throw new Error(`download returned no body: ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.byteLength
      if (onProgress) onProgress({ component: component as 'prometheus' | 'alloy', bytesReceived: received, bytesTotal: total })
      cb(null, chunk)
    },
  })
  await pipeline(nodeStream, meter, createWriteStream(dest))
}

async function extractTarGz(archive: string, destDir: string): Promise<void> {
  await runExtract('tar', ['-xzf', archive, '-C', destDir])
}

async function extractZip(archive: string, destDir: string): Promise<void> {
  await runExtract('unzip', ['-q', archive, '-d', destDir])
}

function runExtract(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) { resolve(); return }
      const detail = Buffer.concat(stderrChunks).toString('utf-8').trim()
      reject(new Error(`${cmd} exited ${code}${detail ? ': ' + detail : ''}`))
    })
  })
}
