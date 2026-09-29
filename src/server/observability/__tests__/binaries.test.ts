import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { installBinary } from '../../infra/binaries'
import type { BinaryTarget } from '../../infra/types'

let tmpBase: string
let httpServer: Server
let port: number

beforeEach(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), 'tinstar-bin-test-'))
  await new Promise<void>((resolve) => {
    httpServer = createServer((req, res) => {
      if (req.url === '/good.tar.gz') {
        res.writeHead(200, { 'Content-Length': goodTarball.length })
        res.end(goodTarball)
      } else if (req.url === '/bad.tar.gz') {
        res.writeHead(200, { 'Content-Length': goodTarball.length })
        res.end(Buffer.concat([goodTarball.subarray(0, goodTarball.length - 1), Buffer.from([0xff])]))
      } else {
        res.writeHead(404)
        res.end()
      }
    }).listen(0, '127.0.0.1', () => {
      port = (httpServer.address() as { port: number }).port
      resolve()
    })
  })
})

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true })
  httpServer.close()
})

// A tiny valid tar.gz with one file "prometheus-0.0.0/prometheus" containing "#!/bin/sh\necho ok\n"
// Built once at module load with Node's tar/zlib.
import { gzipSync } from 'node:zlib'

function makeTarBlock(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.padEnd(100, '\0'), 0, 'ascii')
  header.write('0000644\0', 100, 'ascii')             // mode (octal) + null
  header.write('0000000\0', 108, 'ascii')             // uid
  header.write('0000000\0', 116, 'ascii')             // gid
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii') // size
  header.write('00000000000\0', 136, 'ascii')         // mtime
  header.write('        ', 148, 'ascii')              // checksum placeholder
  header.write('0', 156, 'ascii')                     // type = regular file
  // compute checksum
  let sum = 0
  for (const b of header) sum += b
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  const contentPadded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(contentPadded, 0)
  return Buffer.concat([header, contentPadded])
}
const binaryContent = Buffer.from('#!/bin/sh\necho ok\n', 'utf-8')
const tarBuf = Buffer.concat([
  makeTarBlock('prometheus-0.0.0/prometheus', binaryContent),
  Buffer.alloc(1024), // trailer
])
const goodTarball = gzipSync(tarBuf)
const goodSha256 = createHash('sha256').update(goodTarball).digest('hex')

function target(urlPath: string, sha256: string): BinaryTarget {
  return {
    component: 'prometheus',
    version: '0.0.0',
    url: `http://127.0.0.1:${port}${urlPath}`,
    sha256,
    executableRelPath: 'prometheus-0.0.0/prometheus',
    archiveKind: 'tar.gz',
  }
}

describe('binaries.installBinary', () => {
  it('downloads, verifies sha256, extracts, and writes the binary to the target path', async () => {
    const installDir = join(tmpBase, 'bin')
    const result = await installBinary(target('/good.tar.gz', goodSha256), installDir)
    expect(existsSync(result.binaryPath)).toBe(true)
    expect(readFileSync(result.binaryPath).toString()).toBe('#!/bin/sh\necho ok\n')
  })

  it('rejects on sha256 mismatch and leaves no partial files', async () => {
    const installDir = join(tmpBase, 'bin')
    await expect(installBinary(target('/bad.tar.gz', goodSha256), installDir)).rejects.toThrow(/checksum/i)
    // no binary installed
    expect(existsSync(join(installDir, 'prometheus-0.0.0'))).toBe(false)
  })

  it('skips download when binary already installed and valid', async () => {
    const installDir = join(tmpBase, 'bin')
    await installBinary(target('/good.tar.gz', goodSha256), installDir)
    // second call — even with unreachable URL, succeeds because cached
    const bad = { ...target('/does-not-exist', goodSha256) }
    const result = await installBinary(bad, installDir)
    expect(existsSync(result.binaryPath)).toBe(true)
  })
})
