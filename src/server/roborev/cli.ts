import { execFile } from 'node:child_process'

/** Subset of a `roborev list --json` row that the cockpit consumes. Extra
 *  daemon fields are preserved at runtime but not typed. */
export interface RoborevReview {
  id: number
  branch: string
  repo_path: string
  repo_name: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  verdict: string | null   // 'P' = pass; null until scored
  closed: boolean
  commit_subject: string
  git_ref: string
  finished_at: string | null
}

/** Subset of `roborev show --json`. */
export interface RoborevShow {
  id: number
  job_id: number
  output: string
  verdict_bool: number
  closed: boolean
}

export type RoborevActionInput =
  | { jobId: number; action: 'close' | 'reopen' }
  | { jobId: number; action: 'comment'; message: string }

const MAX_BUFFER = 16 * 1024 * 1024 // roborev show output can be large

// Uses the real Node.js execFile callback signature: cb(err, stdout, stderr)
// where stdout and stderr are positional string arguments.
function run(repoPath: string, args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('roborev', args, { cwd: repoPath, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || (err as Error).message || '').toString().trim()
        reject(new Error(`${label} failed${detail ? ': ' + detail : ''}`))
        return
      }
      resolve((stdout ?? '').toString())
    })
  })
}

export async function listReviews(repoPath: string): Promise<RoborevReview[]> {
  const out = (await run(repoPath, ['list', '--json'], 'roborev list')).trim()
  if (!out) return []
  return JSON.parse(out) as RoborevReview[]
}

export async function showReview(repoPath: string, jobId: number): Promise<RoborevShow> {
  const out = await run(repoPath, ['show', '--job', String(jobId), '--json'], 'roborev show')
  return JSON.parse(out) as RoborevShow
}

export async function runAction(repoPath: string, input: RoborevActionInput): Promise<void> {
  let args: string[]
  switch (input.action) {
    case 'close':
      args = ['close', String(input.jobId)]
      break
    case 'reopen':
      args = ['close', String(input.jobId), '--reopen']
      break
    case 'comment': {
      const msg = (input.message ?? '').trim()
      if (!msg) throw new Error('comment message required')
      args = ['comment', '--job', String(input.jobId), '-m', msg]
      break
    }
  }
  await run(repoPath, args, `roborev ${input.action}`)
}
