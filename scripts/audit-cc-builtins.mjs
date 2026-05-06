#!/usr/bin/env node
// Audit BUILTIN_SLASH_COMMANDS against the installed Claude Code binary.
//
// Strategy: string-mine the binary for `"/word"` literals, filter out things
// that obviously aren't slash commands (filesystem paths, AWS API endpoints),
// then diff against the constant in slashCommandRegistry.ts. Output is meant
// for human review — bumping the constant is still a manual step because the
// scan is noisy and can't perfectly distinguish a slash command from a URL.
//
// Usage: node scripts/audit-cc-builtins.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = resolve(__dirname, '../src/server/sessions/slashCommandRegistry.ts')

// Names that string-mining will surface but are definitely not slash commands.
// Mostly Bedrock/AWS API path segments and POSIX dirs.
const KNOWN_NOISE = new Set([
  'all', 'allcompartments', 'app', 'async-invoke', 'authorize', 'bash', 'bin',
  'branch', 'btw', 'callback', 'change', 'chrome', 'claims', 'commit',
  'commit-push-pr', 'create', 'custom-models', 'dashboard', 'deploy', 'desktop',
  'dev', 'devicecode', 'dream', 'effort', 'emcc', 'etc', 'evaluation-jobs',
  'events', 'extra-usage', 'fish', 'fo', 'foundation-models', 'groups',
  'guardrails', 'imported-models', 'inference-profiles', 'install-github-app',
  'issue', 'json', 'ld-linux-', 'ld-musl-', 'lib', 'logonid', 'metrics',
  'model-copy-jobs', 'model-customization-jobs', 'model-import-jobs',
  'model-invocation-job', 'model-invocation-jobs', 'morning-checkin', 'nh',
  'opt', 'passes', 'path', 'powerup', 'priv', 'private', 'pro-trial-expired',
  'proc', 'prompt-routers', 'properties', 'rate-limit-options', 'register',
  'sbin', 'sh', 'skills', 'sse', 'stats', 'stream', 'tasks', 'tmp', 'token',
  'transfer', 'urlcache', 'use-case-for-model-access', 'user', 'usr', 'var',
  've', 'worker', 'wrapper', 'ws', 'zsh', 'ack', 'babysit-prs', 'catch-up',
  'b24', 'd01', 'd0d5d', 'e0e1e', 'e4e5e', 'g0h', 'i01', 'cccc', 'ehy', 'ete',
  'fzzj', 'hsisi', 'ient', 'ind', 'ind3', 'index', 'invoke',
  'invoke-with-response-stream', 'jso', 'latest', 'cgroup', 'cmdline', 'code',
  'content', 'ca-cert', 'archive', 'actions-runner', 'automated-reasoning-policies',
  'cancel', 'files', 'gender', 'head', 'heartbeat', 'include',
])

function findClaudeBinary() {
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' })
  if (which.status !== 0) throw new Error('claude not found in PATH')
  let p = which.stdout.trim()
  // Resolve symlinks (claude is typically a symlink to a versioned binary)
  while (statSync(p).isSymbolicLink?.() || statSync(p).isFile() === false || (() => {
    try { readlinkSync(p); return true } catch { return false }
  })()) {
    try {
      const target = readlinkSync(p)
      p = resolve(dirname(p), target)
    } catch {
      break
    }
  }
  return p
}

function extractCandidates(binary) {
  // strings <bin> | grep -oE '"/[a-z][a-z0-9-]+"'
  const out = execFileSync('bash', ['-c', `strings ${JSON.stringify(binary)} | grep -oE '"/[a-z][a-z0-9-]{1,25}"' | sort -u`], { encoding: 'utf8' })
  return out
    .split('\n')
    .map(s => s.trim().replace(/^"\//, '').replace(/"$/, ''))
    .filter(Boolean)
    .filter(s => !KNOWN_NOISE.has(s))
}

function readKnownBuiltins() {
  const src = readFileSync(REGISTRY_PATH, 'utf8')
  const start = src.indexOf('BUILTIN_SLASH_COMMANDS')
  if (start === -1) throw new Error('BUILTIN_SLASH_COMMANDS not found in registry')
  const end = src.indexOf(']', start)
  const block = src.slice(start, end)
  const names = [...block.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1])
  return new Set(names)
}

function getClaudeVersion() {
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  return v.stdout.trim()
}

function main() {
  const binary = findClaudeBinary()
  const version = getClaudeVersion()
  const candidates = new Set(extractCandidates(binary))
  const known = readKnownBuiltins()

  const newCandidates = [...candidates].filter(c => !known.has(c)).sort()
  const removed = [...known].filter(c => !candidates.has(c)).sort()

  console.log(`Claude Code: ${version}`)
  console.log(`Binary:      ${binary}`)
  console.log(`Known:       ${known.size} built-ins in slashCommandRegistry.ts`)
  console.log(`Candidates:  ${candidates.size} after noise filter`)
  console.log()
  if (newCandidates.length === 0 && removed.length === 0) {
    console.log('No changes. Built-in list is up to date.')
    return
  }
  if (newCandidates.length > 0) {
    console.log('NEW candidates (review and add to BUILTIN_SLASH_COMMANDS if real):')
    for (const c of newCandidates) console.log(`  + /${c}`)
    console.log()
  }
  if (removed.length > 0) {
    console.log('REMOVED — in known list but not found in binary (may have been removed from CC, or noise):')
    for (const c of removed) console.log(`  - /${c}`)
    console.log()
  }
  console.log('Verify candidates against in-app /help before editing the constant.')
}

main()
