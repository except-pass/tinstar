import { watch, mkdirSync, readFileSync, unlinkSync, renameSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { parseFrontmatter, bustSkillCache } from './skill-discovery'
import type { SSEBroadcaster } from '../api/sse'

export const DRAFTS_DIR = join(homedir(), '.config', 'tinstar', 'skill-drafts')

export function ensureDraftsDir(): void {
  mkdirSync(DRAFTS_DIR, { recursive: true })
}

/** Move a draft to its final location (system or repo). Returns the final path. */
export function saveDraft(draftId: string, location: 'system' | 'repo', projectRoot?: string): string {
  const draftPath = join(DRAFTS_DIR, `${draftId}.md`)
  if (!existsSync(draftPath)) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  const content = readFileSync(draftPath, 'utf-8')
  const fm = parseFrontmatter(content)
  const skillName = fm.name ?? draftId

  let destDir: string
  if (location === 'system') {
    destDir = join(homedir(), '.claude', 'commands')
  } else {
    if (!projectRoot) throw new Error('projectRoot required for repo-level skills')
    destDir = join(projectRoot, '.claude', 'commands')
  }

  mkdirSync(destDir, { recursive: true })

  const destPath = join(destDir, `${skillName}.md`)
  if (existsSync(destPath)) {
    throw Object.assign(new Error('skill-name-conflict'), { existingPath: destPath })
  }

  renameSync(draftPath, destPath)
  bustSkillCache()
  return destPath
}

export function discardDraft(draftId: string): void {
  const draftPath = join(DRAFTS_DIR, `${draftId}.md`)
  try {
    unlinkSync(draftPath)
  } catch { /* already gone */ }
}

/** Watch the drafts directory and emit SSE events when new drafts appear. */
export function watchDrafts(sse: SSEBroadcaster): () => void {
  ensureDraftsDir()

  const watcher = watch(DRAFTS_DIR, (eventType, filename) => {
    if (eventType !== 'rename' || !filename || extname(filename) !== '.md') return
    const draftPath = join(DRAFTS_DIR, filename)
    if (!existsSync(draftPath)) return  // deleted, not created

    const draftId = filename.replace(/\.md$/, '')
    let skillName = draftId  // fallback
    try {
      const content = readFileSync(draftPath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (fm.name) skillName = fm.name
    } catch { /* use fallback */ }

    sse.broadcastEvent('skill.drafted', { draftId, skillName })
  })

  return () => watcher.close()
}
