import { useState, useEffect, useCallback, useRef } from 'react'
import type { SkillDTO, PendingSkill } from '../types'

export interface SkillsState {
  skills: SkillDTO[]
  loading: boolean
  pendingSkills: PendingSkill[]
  pickerContext: { taskId: string } | null
  savingDraft: { draftId: string; skillName: string; pendingSkillId: string; sessionId: string } | null
}

export interface SkillsActions {
  fetchSkills: () => Promise<void>
  openPicker: (taskId: string) => void
  closePicker: () => void
  addPendingSkill: (skill: PendingSkill) => void
  resolvePendingSkill: (id: string, finalName: string) => void
  errorPendingSkill: (id: string) => void
  removePendingSkill: (id: string) => void
  clearSavingDraft: () => void
}

export function useSkills(): SkillsState & SkillsActions {
  const [skills, setSkills] = useState<SkillDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [pendingSkills, setPendingSkills] = useState<PendingSkill[]>([])
  const [pickerContext, setPickerContext] = useState<{ taskId: string } | null>(null)
  const [savingDraft, setSavingDraft] = useState<{ draftId: string; skillName: string; pendingSkillId: string; sessionId: string } | null>(null)
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Subscribe to skill.drafted and skill.saved SSE events
  useEffect(() => {
    const es = new EventSource('/api/events')

    es.addEventListener('skill.drafted', (e: MessageEvent) => {
      const { draftId, skillName } = JSON.parse(e.data) as { draftId: string; skillName: string }
      // Cancel timeout for this pending skill
      const timeout = timeoutsRef.current.get(draftId)
      if (timeout) { clearTimeout(timeout); timeoutsRef.current.delete(draftId) }
      // Transition matching pending skill to 'saving'
      setPendingSkills(prev => prev.map(ps =>
        ps.id === draftId ? { ...ps, status: 'saving' as const } : ps
      ))
      setSavingDraft({ draftId, skillName, pendingSkillId: draftId, sessionId: '' })
    })

    es.addEventListener('skill.saved', () => {
      // Cache busted server-side; re-fetch will happen on next picker open
    })

    return () => es.close()
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

  const openPicker = useCallback((taskId: string) => {
    setPickerContext({ taskId })
  }, [])

  const closePicker = useCallback(() => {
    setPickerContext(null)
  }, [])

  const addPendingSkill = useCallback((skill: PendingSkill) => {
    setPendingSkills(prev => [...prev, skill])
    // Set 30s timeout → error state
    const timeout = setTimeout(() => {
      setPendingSkills(prev => prev.map(ps =>
        ps.id === skill.id && ps.status === 'defining' ? { ...ps, status: 'error' as const } : ps
      ))
      timeoutsRef.current.delete(skill.id)
    }, 30_000)
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

  return {
    skills, loading, pendingSkills, pickerContext, savingDraft,
    fetchSkills, openPicker, closePicker, addPendingSkill,
    resolvePendingSkill, errorPendingSkill, removePendingSkill, clearSavingDraft,
  }
}
