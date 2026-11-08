#!/usr/bin/env node
// Operator-only staging. Never invoked by the web server or action broker.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

try {
  const destination = process.argv[2]
  if (process.platform !== 'linux' || !destination || !isAbsolute(destination) || resolve(destination) !== destination || destination.startsWith('/home/') || destination === '/') throw new Error('Choose an unused absolute runtime directory outside host homes')
  const binaries = [process.execPath, '/usr/bin/prlimit']
  if (binaries.some(path => path.startsWith('/home/'))) throw new Error('Use an installed Node binary outside host homes')
  const linked = execFileSync('/usr/bin/ldd', binaries, { encoding: 'utf8', env: {} })
  if (linked.includes('not found')) throw new Error('Runtime has unresolved libraries')
  const libraries = [...new Set(linked.match(/\/[^\s():]+/g) ?? [])].filter(path => !binaries.includes(path))
  if (libraries.some(path => path.startsWith('/home/'))) throw new Error('Runtime libraries must be installed outside host homes')
  mkdirSync(destination, { mode: 0o755 })
  mkdirSync(join(destination, 'bin'))
  copyFileSync(process.execPath, join(destination, 'bin/node'))
  copyFileSync('/usr/bin/prlimit', join(destination, 'bin/prlimit'))
  for (const library of libraries) {
    const target = join(destination, library)
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(library, target)
  }
  for (const name of ['proc', 'dev', 'tmp', 'action']) mkdirSync(join(destination, name))
  console.log('Staged Node/prlimit runtime. Run the sandbox safety tests on this host before enabling Reader/Repair.')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Runtime staging failed')
  process.exitCode = 1
}
