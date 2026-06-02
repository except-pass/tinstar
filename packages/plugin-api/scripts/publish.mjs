import { execFileSync } from 'node:child_process'
import { expectedTag } from './resolve-tag.mjs'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['publish', '--tag', expectedTag, ...process.argv.slice(2)], { stdio: 'inherit' })
