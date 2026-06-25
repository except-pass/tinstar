import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TouchedFile, FileKind } from '../../types'
import { log } from '../logger'

const execFileAsync = promisify(execFile)

function inferFileKind(filePath: string): FileKind {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const codeExts = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'rb', 'swift', 'kt', 'cs', 'vue', 'svelte'])
  const configExts = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'conf'])
  const testPatterns = ['.test.', '.spec.', '__tests__', '_test.', 'test_']
  const scriptExts = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'])
  const docExts = new Set(['md', 'txt', 'rst', 'adoc', 'html', 'css', 'scss'])

  if (testPatterns.some(p => filePath.includes(p))) return 'test'
  if (scriptExts.has(ext)) return 'script'
  if (codeExts.has(ext)) return 'code'
  if (configExts.has(ext)) return 'config'
  if (docExts.has(ext)) return 'doc'
  return 'code'
}

/**
 * Run `git diff --numstat` in the given directory and return TouchedFile entries
 * for all uncommitted changes (both staged and unstaged).
 */
export async function getGitDiffFiles(workdir: string): Promise<TouchedFile[]> {
  // Get unstaged changes
  const [unstaged, staged] = await Promise.all([
    execFileAsync('git', ['diff', '--numstat'], { cwd: workdir, timeout: 5000 })
      .catch((err) => { log.debug('git-diff', `unstaged diff failed: ${(err as Error).message}`); return { stdout: '' } }),
    execFileAsync('git', ['diff', '--cached', '--numstat'], { cwd: workdir, timeout: 5000 })
      .catch((err) => { log.debug('git-diff', `staged diff failed: ${(err as Error).message}`); return { stdout: '' } }),
  ])

  // Also get untracked files
  const untracked = await execFileAsync(
    'git', ['ls-files', '--others', '--exclude-standard'],
    { cwd: workdir, timeout: 5000 },
  ).catch((err) => { log.debug('git-diff', `ls-files failed: ${(err as Error).message}`); return { stdout: '' } })

  // Merge staged + unstaged numstat lines (file may appear in both)
  const fileMap = new Map<string, { additions: number; deletions: number }>()

  for (const output of [unstaged.stdout, staged.stdout]) {
    for (const line of output.trim().split('\n')) {
      if (!line) continue
      const [addStr, delStr, filePath] = line.split('\t')
      if (!filePath) continue
      // Binary files show '-' for counts
      const additions = addStr === '-' ? 0 : parseInt(addStr!, 10) || 0
      const deletions = delStr === '-' ? 0 : parseInt(delStr!, 10) || 0
      const existing = fileMap.get(filePath)
      if (existing) {
        existing.additions += additions
        existing.deletions += deletions
      } else {
        fileMap.set(filePath, { additions, deletions })
      }
    }
  }

  // Add untracked files — count lines as additions (entire file is new)
  const untrackedPaths = untracked.stdout.trim().split('\n').filter(l => l && !fileMap.has(l))
  if (untrackedPaths.length > 0) {
    // Batch wc -l for all untracked files
    const wc = await execFileAsync(
      'xargs', ['wc', '-l'],
      { cwd: workdir, timeout: 5000, input: untrackedPaths.join('\n') } as Parameters<typeof execFileAsync>[2],
    ).catch((err) => { log.debug('git-diff', `wc -l failed: ${(err as Error).message}`); return { stdout: '' } })
    const lineCounts = new Map<string, number>()
    for (const wcLine of (wc.stdout as string).trim().split('\n')) {
      const match = wcLine.trim().match(/^(\d+)\s+(.+)$/)
      if (match && match[2] !== 'total') {
        lineCounts.set(match[2]!, parseInt(match[1]!, 10))
      }
    }
    for (const path of untrackedPaths) {
      fileMap.set(path, { additions: lineCounts.get(path) ?? 0, deletions: 0 })
    }
  }

  const files: TouchedFile[] = []
  for (const [filePath, stats] of fileMap) {
    const name = filePath.split('/').pop() ?? filePath
    files.push({
      id: filePath,
      name,
      path: filePath,
      additions: stats.additions,
      deletions: stats.deletions,
      kind: inferFileKind(filePath),
    })
  }

  // Sort: most changes first
  files.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
  return files
}
