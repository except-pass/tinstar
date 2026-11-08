import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getConfigRoot } from '../configRoot.js'

export function run(args = process.argv.slice(3)) {
  // npm executes postinstall on every platform; unconfigured/Linux installs
  // must not require Python, clavis or launchd.
  if (args[0] === 'upgrade' && process.platform !== 'darwin') return
  if (args[0] === 'upgrade') {
    return import('node:fs').then(({ existsSync }) => {
      if (!existsSync(`${getConfigRoot()}/ask-puller.json`) &&
          !(process.env.TINSTAR_ASK_URL && process.env.TINSTAR_ASK_HOME && process.env.TINSTAR_ASK_TOKEN_KEY)) return
      return execute(args)
    })
  }
  if (process.platform !== 'darwin' && args[0] !== 'status') {
    console.error('Ask puller LaunchAgent commands require macOS.')
    process.exitCode = 1
    return
  }
  return execute(args)
}

function execute(args) {
  const script = fileURLToPath(new URL('../../scripts/ask-puller-service.py', import.meta.url))
  const result = spawnSync('python3', [script, ...args, '--config-root', getConfigRoot()], { stdio: 'inherit' })
  if (result.error) console.error('Ask puller requires Python 3 on PATH. See docs/features/ask-puller-service.md.')
  process.exitCode = result.status ?? 1
}
