import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, access, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { z } from 'zod'
import { operationSchema, type ActionCandidate, type ActionOperation, type ActionSnapshot } from '../../shared/actions'
import { sourceDigest } from './examples'

export const runnerResources = z.enum(['pr', 'files', 'reviews', 'checks', 'statuses', 'runs'])
export type RunnerResource = z.infer<typeof runnerResources>
const message = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('propose'), operation: operationSchema }).strict(),
  z.object({ kind: z.literal('read'), resource: runnerResources }).strict(),
])
const bootstrap = `import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
const replies=[]; lines.on('line',line=>{const next=replies.shift(); if(next) next(JSON.parse(line));});
const rpc=value=>new Promise((resolve,reject)=>{replies.push(reply=>reply.ok?resolve(reply.data):reject(new Error('Broker refused operation')));process.stdout.write(JSON.stringify(value)+'\\n');});
const target=JSON.parse(readFileSync('/action/target.json','utf8'));
try {const action=await import('file:///action/implementation.mjs');await action.default(target,{propose:operation=>rpc({kind:'propose',operation}),read:resource=>rpc({kind:'read',resource})});process.exit(0);} catch {process.exit(1);}
`

/** seccomp prevents subprocess/fork bombs while permitting Node's pthreads.
 * clone3 returns ENOSYS so libc falls back to clone, whose flags we inspect.
 * Together with RLIMIT_AS/CPU this bounds the whole single-process action.
 * Unknown architectures refuse rather than running without the process boundary. */
export function runnerSeccomp(arch = process.arch): Buffer {
  const syscalls = arch === 'x64' ? { audit: 0xc000003e, clone: 56, clone3: 435, fork: 57, vfork: 58 } :
    arch === 'arm64' ? { audit: 0xc00000b7, clone: 220, clone3: 435, fork: -1, vfork: -1 } : null
  if (!syscalls) throw new Error('Isolated runner unavailable: unsupported seccomp architecture')
  const instructions: number[][] = [
    [0x20, 0, 0, 4], [0x15, 1, 0, syscalls.audit], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0],
    // Reject x32 syscall aliases, which could otherwise bypass syscall matching.
    ...(arch === 'x64' ? [[0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001]] : []),
    [0x15, 0, 1, syscalls.clone3], [0x06, 0, 0, 0x00050026],
    ...[syscalls.fork, syscalls.vfork].filter(n => n >= 0).flatMap(n => [[0x15, 0, 1, n], [0x06, 0, 0, 0x00050001]]),
    [0x15, 0, 3, syscalls.clone], [0x20, 0, 0, 16], [0x45, 1, 0, 0x00010000], [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
  ]
  const buffer = Buffer.alloc(instructions.length * 8)
  instructions.forEach(([code, jt, jf, k], i) => { buffer.writeUInt16LE(code!, i * 8); buffer[i * 8 + 2] = jt!; buffer[i * 8 + 3] = jf!; buffer.writeUInt32LE(k! >>> 0, i * 8 + 4) })
  return buffer
}

export interface SandboxConfig { runtime: string; bwrap?: string }
/** Only trusted runtime files are mounted. No HOME, host proc, credentials,
 * shared socket or network; stdin/stdout are the bounded typed broker channel.
 * Failure to start bwrap is a refusal, never an unsandboxed retry. */
export async function isolatedRunner(candidate: ActionCandidate, target: ActionSnapshot, signal: AbortSignal, config: SandboxConfig,
  read: (resource: RunnerResource) => Promise<unknown>): Promise<ActionOperation> {
  signal.throwIfAborted()
  if (process.platform !== 'linux' || !isAbsolute(config.runtime) || config.runtime.startsWith('/home/') || config.runtime === '/') throw new Error('Isolated runner not provisioned: configure a staged runtime outside host homes')
  let runtime: string
  try {
    runtime = await realpath(config.runtime)
    const info = await stat(runtime)
    if (runtime === '/' || runtime.startsWith('/home/') || !info.isDirectory() || info.mode & 0o022 || info.uid !== 0 && info.uid !== process.getuid?.()) throw new Error()
    await access(join(runtime, 'bin/node')); await access(join(runtime, 'bin/prlimit'))
  } catch { throw new Error('Isolated runner not provisioned: private staged Node/prlimit runtime outside host homes required') }
  if (sourceDigest(candidate.source) !== candidate.manifest.digest) throw new Error('Installed source digest changed')
  const stage = await mkdtemp(join(tmpdir(), 'tinstar-runner-'))
  try {
    await Promise.all([
      writeFile(join(stage, 'implementation.mjs'), candidate.source, { mode: 0o400 }),
      writeFile(join(stage, 'bootstrap.mjs'), bootstrap, { mode: 0o400 }),
      writeFile(join(stage, 'target.json'), JSON.stringify(target), { mode: 0o400 }),
    ])
    const filter = runnerSeccomp()
    return await new Promise<ActionOperation>((resolve, reject) => {
      const child = spawn(config.bwrap ?? '/usr/bin/bwrap', [
        '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--uid', '65534', '--gid', '65534', '--clearenv', '--ro-bind', runtime, '/', '--ro-bind', stage, '/action',
        '--proc', '/proc', '--dev', '/dev', '--size', '16777216', '--tmpfs', '/tmp', '--chdir', '/tmp', '--seccomp', '3', '--',
        '/bin/prlimit', '--cpu=2:2', '--as=1073741824:1073741824', '--nproc=32:32', '--nofile=64:64', '--fsize=16777216:16777216', '--core=0:0', '--',
        '/bin/node', '--jitless', '--disable-wasm-trap-handler', '--max-old-space-size=64', '/action/bootstrap.mjs',
      ], { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      let proposal: ActionOperation | undefined, bytes = 0, calls = 0, pending = '', stopped = false
      let chain = Promise.resolve()
      const finish = (error?: Error) => {
        if (stopped) return
        stopped = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
        child.kill('SIGKILL')
        if (error) reject(error)
        else if (proposal) resolve(proposal)
        else reject(new Error('Isolated runner returned no typed operation'))
      }
      const abort = () => finish(new Error('Isolated runner cancelled'))
      const timer = setTimeout(() => finish(new Error('Isolated runner wall-clock limit exceeded')), candidate.manifest.limits.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      child.on('error', () => finish(new Error('Isolated runner unavailable: bubblewrap/prlimit could not start; no fallback')))
      child.stdin.on('error', () => {})
      const count = (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > candidate.manifest.limits.outputBytes) finish(new Error('Isolated runner output limit exceeded'))
      }
      child.stderr.on('data', count) // Never relay untrusted stderr to logs or receipts.
      child.stdout.on('data', (chunk: Buffer) => {
        count(chunk); if (stopped) return
        pending += chunk.toString('utf8')
        for (let end; (end = pending.indexOf('\n')) >= 0;) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1)
          chain = chain.then(async () => {
            if (stopped) return
            if (++calls > 32) throw new Error('Isolated runner RPC limit exceeded')
            const request = message.parse(JSON.parse(line))
            let data: unknown = null
            if (request.kind === 'propose') {
              if (proposal) throw new Error('Isolated runner may propose only one operation')
              proposal = request.operation
            } else data = await read(request.resource)
            const response = JSON.stringify({ ok: true, data }) + '\n'
            if (Buffer.byteLength(response) > 4 * 1024 * 1024) throw new Error('Broker read output limit exceeded')
            if (!stopped) child.stdin.write(response)
          }).catch(() => finish(new Error('Isolated runner broker request refused')))
        }
      })
      const seccompPipe = child.stdio[3] as NodeJS.WritableStream
      seccompPipe.on('error', () => {})
      seccompPipe.end(filter)
      child.on('close', code => { void chain.then(() => finish(code === 0 && !pending ? undefined : new Error('Isolated runner refused: namespaces/runtime unavailable or OS resource limits exceeded; no fallback'))) })
    })
  } finally { await rm(stage, { recursive: true, force: true }) }
}
