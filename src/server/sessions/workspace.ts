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

/**
 * Thrown when a worktree branch can't be created because the name is blocked by
 * an existing sub-branch (a git directory/file ref conflict). Example: a branch
 * `cockpit/soak-evidence` makes `cockpit` a ref *directory*, so a plain branch
 * `cockpit` is impossible. Kept as a distinct type so createSessionInternal can
 * translate it into a clean 409 instead of leaking git's cryptic
 * "fatal: invalid reference: <name>".
 */
export class WorktreeBranchConflictError extends Error {
  constructor(public readonly name: string, public readonly conflict: string) {
    super(`Can't create worktree branch '${name}': a branch '${conflict}' already exists. Pick a different name.`)
    this.name = 'WorktreeBranchConflictError'
  }
}

/** Whether a new worktree branch named `name` can be made in `projectPath`. */
export type WorktreeBranchCheck =
  | { ok: true; action: 'create' } // no such ref — safe to `-b`
  | { ok: true; action: 'attach' } // exact branch exists — check it out
  | { ok: false; conflict: string } // a `name/…` sub-branch blocks it (D/F conflict)

/**
 * Classify whether we can create (or attach to) a branch named `name`, WITHOUT
 * mutating anything. One `for-each-ref` returns the exact ref and any sub-refs;
 * a sub-ref present means git can't hold both a branch and a directory at that
 * path (the "cockpit" bug). Best-effort: if the query itself fails (e.g. not a
 * git repo), we assume 'create' and let the real worktree-add surface any error.
 */
export async function checkWorktreeBranch(projectPath: string, name: string): Promise<WorktreeBranchCheck> {
  let refs: string
  try {
    refs = await git(['-C', projectPath, 'for-each-ref', '--format=%(refname)', `refs/heads/${name}`])
  } catch {
    return { ok: true, action: 'create' }
  }
  const lines = refs.split('\n').filter(Boolean)
  const subref = lines.find(l => l.startsWith(`refs/heads/${name}/`))
  if (subref) return { ok: false, conflict: subref.slice('refs/heads/'.length) }
  if (lines.includes(`refs/heads/${name}`)) return { ok: true, action: 'attach' }
  return { ok: true, action: 'create' }
}

export async function createWorktree(projectPath: string, sessionName: string): Promise<string> {
  const wtDir = worktreeDir(projectPath, sessionName)
  mkdirSync(dirname(wtDir), { recursive: true })

  if (existsSync(wtDir)) {
    return wtDir
  }

  // Decide -b (new branch) vs attach (existing branch) up front rather than
  // blindly retrying without -b on any failure — that old fallback masked the
  // real error and emitted "invalid reference" when the name was actually blocked.
  const check = await checkWorktreeBranch(projectPath, sessionName)
  if (!check.ok) {
    throw new WorktreeBranchConflictError(sessionName, check.conflict)
  }
  if (check.action === 'attach') {
    await git(['-C', projectPath, 'worktree', 'add', wtDir, sessionName])
  } else {
    await git(['-C', projectPath, 'worktree', 'add', wtDir, '-b', sessionName])
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

/**
 * Metadata for a registered project. Persisted in `projects.json` keyed by
 * project name. Legacy files store a bare path string per project; those are
 * normalized to this object shape on read (see `normalizeProjects`).
 */
export interface ProjectMeta {
  path: string
  starred: boolean
  hidden: boolean
  order: number
}

/** On-disk value shape: either a legacy path string or a (possibly partial) object. */
type RawProjectValue = string | (Partial<ProjectMeta> & { path: string })

function readRawProjects(path: string): Record<string, RawProjectValue> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Normalize a raw project map (mix of legacy strings and objects) into fully
 * populated `ProjectMeta` objects. Legacy string values expand to a non-starred,
 * non-hidden project whose `order` is its position in the file. Objects have any
 * missing flags defaulted to `false` and a missing `order` set to file position.
 */
function normalizeProjects(raw: Record<string, RawProjectValue>): Record<string, ProjectMeta> {
  const out: Record<string, ProjectMeta> = {}
  Object.keys(raw).forEach((name, index) => {
    const value = raw[name]!
    if (typeof value === 'string') {
      out[name] = { path: value, starred: false, hidden: false, order: index }
    } else {
      out[name] = {
        path: value.path,
        starred: value.starred ?? false,
        hidden: value.hidden ?? false,
        order: value.order ?? index,
      }
    }
  })
  return out
}

function writeProjects(path: string, data: Record<string, ProjectMeta>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

/** All projects as normalized metadata objects (legacy string files are upgraded on read). */
export function listProjects(projectsFile: string): Record<string, ProjectMeta> {
  return normalizeProjects(readRawProjects(projectsFile))
}

/** The filesystem path for a project, or null if unknown. Callers creating sessions rely on this. */
export function getProject(projectsFile: string, name: string): string | null {
  const projects = normalizeProjects(readRawProjects(projectsFile))
  // Object.hasOwn guards against inherited names like "toString"/"constructor"
  // being mistaken for registered projects.
  return Object.hasOwn(projects, name) ? projects[name]!.path : null
}

/**
 * Register (or re-point) a project. An existing project keeps its flags and
 * order and only updates its path; a new project is appended after the current
 * max order, non-starred and visible. Always writes the normalized object form,
 * upgrading legacy files on first write.
 */
export function registerProject(projectsFile: string, name: string, path: string): void {
  const projects = normalizeProjects(readRawProjects(projectsFile))
  if (Object.hasOwn(projects, name)) {
    projects[name] = { ...projects[name]!, path }
  } else {
    const maxOrder = Object.values(projects).reduce((m, p) => Math.max(m, p.order), -1)
    projects[name] = { path, starred: false, hidden: false, order: maxOrder + 1 }
  }
  writeProjects(projectsFile, projects)
}

export function unregisterProject(projectsFile: string, name: string): boolean {
  const projects = normalizeProjects(readRawProjects(projectsFile))
  if (!Object.hasOwn(projects, name)) return false
  delete projects[name]
  writeProjects(projectsFile, projects)
  return true
}

/**
 * Toggle a project's starred and/or hidden flags. Returns the updated metadata,
 * or null if the project does not exist. Flags left undefined are untouched.
 */
export function setProjectFlag(
  projectsFile: string,
  name: string,
  flags: { starred?: boolean; hidden?: boolean },
): ProjectMeta | null {
  const projects = normalizeProjects(readRawProjects(projectsFile))
  if (!Object.hasOwn(projects, name)) return null
  const existing = projects[name]!
  const updated: ProjectMeta = {
    ...existing,
    ...(flags.starred !== undefined ? { starred: flags.starred } : {}),
    ...(flags.hidden !== undefined ? { hidden: flags.hidden } : {}),
  }
  projects[name] = updated
  writeProjects(projectsFile, projects)
  return updated
}

/**
 * Reassign project `order` to match the given name sequence. Rejects (without
 * writing) if any name is not a registered project, or if `names` contains
 * duplicates. Registered projects omitted from `names` are appended after the
 * listed ones, preserving their prior relative order.
 */
export function reorderProjects(
  projectsFile: string,
  names: string[],
): { ok: true } | { ok: false; unknown?: string[]; duplicate?: string[] } {
  const projects = normalizeProjects(readRawProjects(projectsFile))
  const unknown = names.filter(n => !Object.hasOwn(projects, n))
  if (unknown.length > 0) return { ok: false, unknown }

  const duplicate = names.filter((n, i) => names.indexOf(n) !== i)
  if (duplicate.length > 0) return { ok: false, duplicate: [...new Set(duplicate)] }

  const listed = new Set(names)
  const omitted = Object.keys(projects)
    .filter(n => !listed.has(n))
    .sort((a, b) => projects[a]!.order - projects[b]!.order)
  const ordered = [...names, ...omitted]
  ordered.forEach((name, index) => {
    projects[name] = { ...projects[name]!, order: index }
  })
  writeProjects(projectsFile, projects)
  return { ok: true }
}
