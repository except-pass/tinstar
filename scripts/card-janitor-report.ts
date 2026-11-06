import { runJanitorCli } from '../src/server/janitor/cli'

runJanitorCli(process.argv.slice(2)).catch(error => {
  // Never forward fetch/credential diagnostics or source prose to the terminal.
  console.error(error instanceof Error && !['TypeError', 'SyntaxError'].includes(error.name)
    ? error.message : 'Card Janitor failed; verify source availability and input JSON (see --help)')
  process.exitCode = 1
})
