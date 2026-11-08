import { beforeAll, afterAll, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { isolatedRunner } from '../sandbox'
import { sourceDigest } from '../examples'
import { installed, snapshot } from './fixtures'
import { stageTestRuntime } from './runtimeFixture'

let runtime: string
beforeAll(async () => { runtime = await stageTestRuntime() })
afterAll(async () => { if (runtime) await rm(runtime, { recursive: true, force: true }) })
function candidate(source: string, timeoutMs = 4000) {
  const action = installed('explain')
  return { source, manifest: { ...action.manifest, digest: sourceDigest(source), limits: { ...action.manifest.limits, timeoutMs } } }
}
const execute = (source: string, timeout = 4000, read: () => Promise<unknown> = async () => ({})) =>
  isolatedRunner(candidate(source, timeout), snapshot(), new AbortController().signal, { runtime }, read)

it('runs reviewed source with only typed reads and one typed proposal', async () => {
  await expect(execute("export default async (target, broker) => {await broker.read('pr'); await broker.propose({kind:'explain'});}")).resolves.toEqual({ kind: 'explain' })
})
it.each([
  ['identity and cleared ambient environment', "if(process.getuid()!==65534 || JSON.stringify(process.env)!==JSON.stringify({PWD:'/tmp'})) fail();"],
  ['host files and credentials', "for(const path of ['/home/farm/.config/gh/hosts.yml','/home','/var/lib/tinstar-action-broker/credentials/reader.pem']) {try {fs.statSync(path);fail()}catch(e){if(e.message==='escape succeeded')throw e}}"],
  ['host process environment', "try {const env=fs.readFileSync('/proc/1/environ','utf8'); if(env.includes('GH_TOKEN')||env.includes('TINSTAR')||env.includes('/home/farm'))fail();}catch(e){if(e.message==='escape succeeded')throw e}"],
  ['writes outside tmp', "try {fs.writeFileSync('/outside','escape');fail()} catch(e){if(e.message==='escape succeeded')throw e} fs.writeFileSync('/tmp/allowed','yes');"],
  ['host process signals', `try {process.kill(${process.pid},0);fail()} catch(e){if(e.message==='escape succeeded')throw e}`],
  ['fork bombs', "for(let i=0;i<16;i++){const child=spawnSync('/bin/node',['-e','process.exit(0)']);if(!child.error)fail();}"],
  ['TCP egress', "await new Promise((resolve,reject)=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(250,()=>{socket.destroy();resolve()});socket.once('connect',()=>{socket.destroy();reject(new Error('escape succeeded'))});socket.once('error',()=>resolve());});"],
  ['DNS egress', "try {await dns.resolve4('example.com');fail()}catch(e){if(e.message==='escape succeeded')throw e}"],
])('blocks sandbox escape: %s', async (_name, probe) => {
  const source = `import fs from 'node:fs'; import net from 'node:net'; import dns from 'node:dns/promises'; import {spawnSync} from 'node:child_process';
export default async (_,broker)=>{const fail=()=>{throw new Error('escape succeeded')}; ${probe} await broker.propose({kind:'explain'});}`
  await expect(execute(source)).resolves.toEqual({ kind: 'explain' })
})
it('refuses malformed RPC and broker operations outside its typed channel', async () => {
  await expect(execute("export default async (_,b)=>b.read('/etc/passwd')")).rejects.toThrow('broker request refused')
  await expect(execute("export default async ()=>process.stdout.write('not-json\\n')")).rejects.toThrow('broker request refused')
})
it('bounds CPU, memory, wall clock and output without evaluating a fallback', async () => {
  await expect(execute('export default async ()=>{while(true){}}')).rejects.toThrow('resource limits')
  await expect(execute('export default async ()=>{const buffers=[];while(true)buffers.push(Buffer.alloc(16*1024*1024,1))}')).rejects.toThrow('resource limits')
  await expect(execute('export default async ()=>{await new Promise(()=>{})}', 300)).rejects.toThrow('wall-clock')
  await expect(execute("export default async ()=>process.stdout.write('x'.repeat(100000))")).rejects.toThrow('output limit')
}, 12000)
it('refuses a missing runtime or missing isolation tools and never runs source on the host', async () => {
  const action = candidate("export default async (_,b)=>b.propose({kind:'explain'})")
  await expect(isolatedRunner(action, snapshot(), new AbortController().signal, { runtime: '/missing' }, async () => null)).rejects.toThrow('not provisioned')
  await expect(isolatedRunner(action, snapshot(), new AbortController().signal, { runtime, bwrap: '/missing' }, async () => null)).rejects.toThrow('no fallback')
})
