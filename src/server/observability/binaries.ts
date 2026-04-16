import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
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
  const entries = (await (await import('node:fs/promises')).readdir(staging))
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
  const { chmodSync } = await import('node:fs')
  chmodSync(binaryPath, 0o755)

  // Write sidecar for cache check.
  const { writeFileSync } = await import('node:fs')
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
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const out = createWriteStream(dest)
  const reader = res.body!.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.write(value)
    received += value.byteLength
    if (onProgress) onProgress({ component: component as 'prometheus' | 'alloy', bytesReceived: received, bytesTotal: total })
  }
  await new Promise<void>((resolve, reject) => out.end((err: Error | null | undefined) => (err ? reject(err) : resolve())))
}

async function extractTarGz(archive: string, destDir: string): Promise<void> {
  // Use `tar -xzf` via child_process — tar is standard on macOS+Linux.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destDir])
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
    child.on('error', reject)
  })
}

async function extractZip(archive: string, destDir: string): Promise<void> {
  // Use `unzip` — standard on macOS+Linux.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-q', archive, '-d', destDir])
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))))
    child.on('error', reject)
  })
}
