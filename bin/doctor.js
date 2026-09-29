#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from './configRoot.js'
import { TTYD_MIN_VERSION, TAILSCALE_MIN_VERSION, checkExternalVersion } from './tinstar/diagnostics.js'

function version(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000 }).trim() } catch { return null }
}

export async function doctor() {
  let failed = false
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failed = true
  }
  check('tmux', !!version('tmux', ['-V']))
  const ttyd = version('ttyd', ['--version'])
  const ttydCheck = checkExternalVersion('ttyd', ttyd?.match(/\d+\.\d+\.\d+/)?.[0] ?? null, TTYD_MIN_VERSION)
  check('ttyd', ttydCheck.status === 'pass', ttydCheck.detail)
  check('python3', !!version('python3', ['--version']))
  const root = getConfigRoot()
  let homes = []
  try {
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    homes = Array.isArray(config.firstmate?.homes) ? config.firstmate.homes : []
  } catch { /* default config has no homes */ }
  for (const home of homes) check(`First Mate home ${home}`, existsSync(join(home, 'bin', 'fm-fleet-snapshot.sh')))
  const tailscale = version('tailscale', ['version'])?.split('\n')[0] ?? null
  if (tailscale) {
    const reachCheck = checkExternalVersion('tailscale', tailscale, TAILSCALE_MIN_VERSION)
    check('tailscale', reachCheck.status === 'pass', reachCheck.detail)
  }
  if (failed) process.exitCode = 1
}

if (process.argv[1]?.endsWith('doctor.js')) void doctor()
