import { runJanitorPilotCli } from '../src/server/janitor/pilot'

runJanitorPilotCli(process.argv.slice(2)).catch(() => {
  // Source prose, credentials and transport diagnostics stay out of terminal errors.
  console.error('Card Janitor pilot failed; verify saved input, sample labels and private runtime configuration (see --help)')
  process.exitCode = 1
})
