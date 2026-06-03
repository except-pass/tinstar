import { execFile } from 'node:child_process'

export interface ExecResult { stdout: string; stderr: string; code: number }

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

/** Run a command (argv array, NO shell) in `cwd`. Resolves with stdout/stderr
 *  and the exit code — a non-zero exit is a RESOLVE (callers branch on `code`),
 *  not a reject. Rejects only on spawn failure (ENOENT), timeout, or maxBuffer. */
export function execCommand(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (!argv.length) { reject(new Error('argv must be a non-empty array')); return }
    execFile(
      argv[0]!,
      argv.slice(1),
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER },
      (err, stdout, stderr) => {
        const out = (stdout ?? '').toString()
        const errOut = (stderr ?? '').toString()
        if (err) {
          const code = (err as { code?: unknown }).code
          if (typeof code === 'number') { resolve({ stdout: out, stderr: errOut, code }); return }
          reject(err) // ENOENT / timeout (killed) / maxBuffer exceeded
          return
        }
        resolve({ stdout: out, stderr: errOut, code: 0 })
      },
    )
  })
}
