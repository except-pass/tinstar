/* eslint-disable no-var */
declare global { var __TINSTAR_BACKEND_PORT__: string | undefined }

import { useState, useEffect, useCallback, useRef } from 'react'
import type { SkillDTO, PendingSkill, StoredProcedure } from '../types'
import { randomUUID } from '../uuid'

export interface OptimisticProcedure {
  id: string
  entityId: string
  skillName: string
}

export interface SkillsState {
  skills: SkillDTO[]
  loading: boolean
  pendingSkills: PendingSkill[]
  optimisticProcedures: OptimisticProcedure[]
  pickerContext: { taskId: string; sessionId: string } | null
  savingDraft: { draftId: string; skillName: string; pendingSkillId: string; sessionId: string } | null
}

export interface SkillsActions {
  fetchSkills: () => Promise<void>
  openPicker: (taskId: string, sessionId: string) => void
  closePicker: () => void
  addPendingSkill: (skill: PendingSkill) => void
  resolvePendingSkill: (id: string, finalName: string) => void
  errorPendingSkill: (id: string) => void
  removePendingSkill: (id: string) => void
  clearSavingDraft: () => void
  addOptimisticProcedure: (item: OptimisticProcedure) => void
  removeOptimisticProcedure: (id: string) => void
}

export function useSkills(): SkillsState & SkillsActions {
  const [skills, setSkills] = useState<SkillDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [pendingSkills, setPendingSkills] = useState<PendingSkill[]>([])
  const [optimisticProcedures, setOptimisticProcedures] = useState<OptimisticProcedure[]>([])
  const [pickerContext, setPickerContext] = useState<{ taskId: string; sessionId: string } | null>(null)
  const [savingDraft, setSavingDraft] = useState<{ draftId: string; skillName: string; pendingSkillId: string; sessionId: string } | null>(null)
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingSkillsRef = useRef<PendingSkill[]>([])

  // Keep ref in sync so SSE handlers can read latest pending skills
  useEffect(() => {
    pendingSkillsRef.current = pendingSkills
  }, [pendingSkills])

  // Listen for skill events forwarded from the shared SSE connection in useServerEvents
  useEffect(() => {
    const onDrafted = async (e: Event) => {
      const { draftId, skillName } = JSON.parse((e as CustomEvent).detail) as { draftId: string; skillName: string }
      // Only handle drafts that this window initiated — multiple dev servers share the
      // same skill-drafts dir on disk, so every server fires the event to all its clients
      const matchingSkill = pendingSkillsRef.current.find(ps => ps.id === draftId)
      if (!matchingSkill) return
      // Cancel timeout for this pending skill
      const timeout = timeoutsRef.current.get(draftId)
      if (timeout) { clearTimeout(timeout); timeoutsRef.current.delete(draftId) }

      if (matchingSkill.preferredLocation) {
        // User pre-selected a location — auto-save without showing SaveSkillModal
        setPendingSkills(prev => prev.map(ps =>
          ps.id === draftId ? { ...ps, status: 'saving' as const } : ps
        ))
        try {
          const res = await fetch('/api/skills/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draftId, location: matchingSkill.preferredLocation, sessionId: matchingSkill.sessionId }),
          })
          if (res.ok) {
            // Add procedure to entity
            const { entityId, entityType } = matchingSkill
            const entityPath = entityType === 'task' ? 'tasks' : entityType === 'epic' ? 'epics' : 'initiatives'
            const entityRes = await fetch(`/api/${entityPath}/${entityId}`)
            if (entityRes.ok) {
              const entity = await entityRes.json() as { ok: boolean; data: { settings?: { procedures?: StoredProcedure[] } } }
              const existing = entity.data?.settings?.procedures ?? []
              if (!existing.some(p => p.skillName === skillName)) {
                const newProcedure: StoredProcedure = { id: randomUUID(), skillName }
                await fetch(`/api/${entityPath}/${entityId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ settings: { procedures: [...existing, newProcedure] } }),
                })
              }
            }
            setPendingSkills(prev => prev.filter(ps => ps.id !== draftId))
          } else {
            setPendingSkills(prev => prev.map(ps =>
              ps.id === draftId ? { ...ps, status: 'error' as const } : ps
            ))
          }
        } catch {
          setPendingSkills(prev => prev.map(ps =>
            ps.id === draftId ? { ...ps, status: 'error' as const } : ps
          ))
        }
      } else {
        // No pre-selected location — show SaveSkillModal as before
        setPendingSkills(prev => prev.map(ps =>
          ps.id === draftId ? { ...ps, status: 'saving' as const } : ps
        ))
        setSavingDraft({ draftId, skillName, pendingSkillId: draftId, sessionId: matchingSkill.sessionId })
      }
    }

    const onSaved = () => {
      // Cache busted server-side; re-fetch will happen on next picker open
    }

    window.addEventListener('tinstar:skill.drafted', onDrafted)
    window.addEventListener('tinstar:skill.saved', onSaved)

    return () => {
      window.removeEventListener('tinstar:skill.drafted', onDrafted)
      window.removeEventListener('tinstar:skill.saved', onSaved)
    }
  }, [])

  const fetchSkills = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/skills')
      const data = await res.json() as { skills: SkillDTO[] }
      setSkills(data.skills)
    } finally {
      setLoading(false)
    }
  }, [])

  const openPicker = useCallback((taskId: string, sessionId: string) => {
    setPickerContext({ taskId, sessionId })
  }, [])

  const closePicker = useCallback(() => {
    setPickerContext(null)
  }, [])

  const addPendingSkill = useCallback((skill: PendingSkill) => {
    setPendingSkills(prev => [...prev, skill])
    // Set 10min timeout → error state (skill generation can take several minutes)
    const timeout = setTimeout(() => {
      setPendingSkills(prev => prev.map(ps =>
        ps.id === skill.id && ps.status === 'defining' ? { ...ps, status: 'error' as const } : ps
      ))
      timeoutsRef.current.delete(skill.id)
    }, 600_000)
    timeoutsRef.current.set(skill.id, timeout)
  }, [])

  const resolvePendingSkill = useCallback((id: string, _finalName: string) => {
    setPendingSkills(prev => prev.filter(ps => ps.id !== id))
  }, [])

  const errorPendingSkill = useCallback((id: string) => {
    setPendingSkills(prev => prev.map(ps =>
      ps.id === id ? { ...ps, status: 'error' as const } : ps
    ))
  }, [])

  const removePendingSkill = useCallback((id: string) => {
    const timeout = timeoutsRef.current.get(id)
    if (timeout) { clearTimeout(timeout); timeoutsRef.current.delete(id) }
    setPendingSkills(prev => prev.filter(ps => ps.id !== id))
  }, [])

  const clearSavingDraft = useCallback(() => {
    setSavingDraft(null)
  }, [])

  const addOptimisticProcedure = useCallback((item: OptimisticProcedure) => {
    setOptimisticProcedures(prev => [...prev, item])
  }, [])

  const removeOptimisticProcedure = useCallback((id: string) => {
    setOptimisticProcedures(prev => prev.filter(op => op.id !== id))
  }, [])

  return {
    skills, loading, pendingSkills, optimisticProcedures, pickerContext, savingDraft,
    fetchSkills, openPicker, closePicker, addPendingSkill,
    resolvePendingSkill, errorPendingSkill, removePendingSkill, clearSavingDraft,
    addOptimisticProcedure, removeOptimisticProcedure,
  }
}
