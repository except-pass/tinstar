import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { DocumentStore } from './stores/document-store'
import type { TinstarConfig } from './sessions/config'

export interface CommitRecord {
  sha: string
  subject: string
  body?: string
  authorName: string
  authorEmail: string
  authorDate: string
  observedAt: string
  repo: string
  branch: string
  worktreeId?: string
  taskTags: string[]
  source: 'hook' | 'reconcile'
}

export interface CommitHookPayload {
  sha: string
  repo: string
  branch: string
  message: string
  authorName: string
  authorEmail: string
  authorDate: string
  worktreeId?: string
}

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

export function parseTaskTags(message: string, markerRegex: string): string[] {
  const regex = new RegExp(markerRegex, 'g')
  const tags: string[] = []
  let match: RegExpExecArray | null = regex.exec(message)
  while (match) {
    const tag = match[1] ?? ''
    if (tag) tags.push(tag)
    match = regex.exec(message)
  }
  return uniq(tags)
}

export function buildCommitRecord(payload: CommitHookPayload, source: 'hook' | 'reconcile', markerRegex: string): CommitRecord {
  const lines = payload.message.split(/\r?\n/)
  const [subject, ...bodyLines] = lines
  return {
    sha: payload.sha,
    subject: subject ?? '',
    body: bodyLines.join('\n').trim() || undefined,
    authorName: payload.authorName,
    authorEmail: payload.authorEmail,
    authorDate: payload.authorDate,
    observedAt: new Date().toISOString(),
    repo: payload.repo,
    branch: payload.branch,
    worktreeId: payload.worktreeId,
    taskTags: parseTaskTags(payload.message, markerRegex),
    source,
  }
}

function getCurrentBranch(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function resolveReconciliationRepos(docStore: DocumentStore, config: TinstarConfig): string[] {
  const configured = config.git.reconciliationRepos.filter(p => existsSync(p))
  if (configured.length > 0) return configured
  const fromWorktrees = docStore.getAllWorktrees().map(w => w.worktreePath).filter(Boolean)
  return uniq(fromWorktrees.filter(p => existsSync(p)))
}

export function reconcileGitHistory(docStore: DocumentStore, config: TinstarConfig): { ingested: number; scanned: number; repos: string[] } {
  const repos = resolveReconciliationRepos(docStore, config)
  let scanned = 0
  let ingested = 0

  for (const repoPath of repos) {
    try {
      const args = ['-C', repoPath, 'log', '--date=iso-strict', '--pretty=format:%H%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1e']
      if (config.git.reconciliationBranchScope && config.git.reconciliationBranchScope !== '*') {
        args.push(config.git.reconciliationBranchScope)
      }
      const output = execFileSync('git', args, { encoding: 'utf8' })
      const entries = output.split('\x1e').map(e => e.trim()).filter(Boolean)
      const branch = getCurrentBranch(repoPath)
      for (const entry of entries) {
        const [sha, subject, body, authorName, authorEmail, authorDate] = entry.split('\x1f')
        if (!sha) continue
        scanned += 1
        if (docStore.getCommit(sha)) continue
        const message = [subject ?? '', body ?? ''].filter(Boolean).join('\n')
        const record = buildCommitRecord({
          sha,
          repo: basename(repoPath),
          branch,
          message,
          authorName: authorName ?? '',
          authorEmail: authorEmail ?? '',
          authorDate: authorDate ?? '',
        }, 'reconcile', config.git.taskMarkerRegex)
        if (docStore.upsertCommit(record)) ingested += 1
      }
    } catch {
      // best effort; skip repo if git log fails
    }
  }

  return { ingested, scanned, repos }
}
