import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// --- Git helpers ---

async function git(args: string[], opts: Record<string, unknown> = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { ...opts, encoding: 'utf-8' })
  return (stdout as string).trim()
}

// --- Worktree operations ---

export function worktreeDir(projectPath: string, sessionName: string): string {
  return join(`${projectPath}-worktrees`, sessionName)
}

export async function createWorktree(projectPath: string, sessionName: string): Promise<string> {
  const wtDir = worktreeDir(projectPath, sessionName)
  mkdirSync(dirname(wtDir), { recursive: true })

  if (existsSync(wtDir)) {
    return wtDir
  }

  try {
    await git(['-C', projectPath, 'worktree', 'add', wtDir, '-b', sessionName])
  } catch {
    // Branch might already exist — attach to it
    await git(['-C', projectPath, 'worktree', 'add', wtDir, sessionName])
  }

  // Inherit .claude dir from base repo
  const baseClaude = join(projectPath, '.claude')
  if (existsSync(baseClaude)) {
    const wtClaude = join(wtDir, '.claude')
    cpSync(baseClaude, wtClaude, { recursive: true })
  }

  return wtDir
}

export async function deleteWorktree(projectPath: string, sessionName: string): Promise<void> {
  const wtDir = worktreeDir(projectPath, sessionName)
  if (!existsSync(wtDir)) return

  try {
    await git(['-C', projectPath, 'worktree', 'remove', wtDir, '--force'])
  } catch {
    const { rmSync } = await import('node:fs')
    rmSync(wtDir, { recursive: true, force: true })
    try {
      await git(['-C', projectPath, 'worktree', 'prune'])
    } catch {
      // Best effort
    }
  }
}

export interface WorktreeInfo {
  path: string
  branch?: string
  bare?: boolean
}

export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  let output: string
  try {
    output = await git(['-C', projectPath, 'worktree', 'list', '--porcelain'])
  } catch {
    return []
  }

  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as WorktreeInfo)
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'bare') {
      current.bare = true
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo)

  // Filter out the main worktree
  return worktrees.filter(wt => wt.path !== projectPath)
}

// --- Project registry ---

function readJsonFile(path: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeJsonFile(path: string, data: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

export function listProjects(projectsFile: string): Record<string, string> {
  return readJsonFile(projectsFile)
}

export function getProject(projectsFile: string, name: string): string | null {
  const projects = readJsonFile(projectsFile)
  return projects[name] ?? null
}

export function registerProject(projectsFile: string, name: string, path: string): void {
  const projects = readJsonFile(projectsFile)
  projects[name] = path
  writeJsonFile(projectsFile, projects)
}

export function unregisterProject(projectsFile: string, name: string): boolean {
  const projects = readJsonFile(projectsFile)
  if (!(name in projects)) return false
  delete projects[name]
  writeJsonFile(projectsFile, projects)
  return true
}
