import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Consume the shipped staging CLI, then execute that runtime in safety tests. */
export async function stageTestRuntime() {
  const runtime = await mkdtemp(join(tmpdir(), 'tinstar-node-runtime-'))
  await rm(runtime, { recursive: true })
  execFileSync(process.execPath, [join(process.cwd(), 'bin/tinstar-stage-action-runtime.js'), runtime], { env: {} })
  return runtime
}
