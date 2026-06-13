import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { apiFetch } from '../apiClient'

export interface TinstarConfigClient {
  uploadMaxBytes: number
  ui: {
    promptComposerDefault: boolean
    showEmptyEntities: boolean
    layouts: Record<string, unknown>
    telemetryPanels: {
      cost: boolean
      tokens: boolean
      cacheHit: boolean
      duty: boolean
      turnLength: boolean
    }
    // Mirrors WidgetSizePresets in src/widgets/widgetSizePresets.ts
    widgetSizePresets: {
      small: number
      medium: number
      large: number
      defaultAspect: number
      aspectByType: Record<string, number>
    }
  }
  // server-side-only fields (cliTemplates, ports, etc.) come through as `unknown`
  [k: string]: unknown
}

// Omit `ui` from the base Partial before re-adding it: a plain intersection would
// collapse `ui` back to its full required shape (Full & Partial<Ui> = Full),
// which is what forced callers into `as never` casts for partial ui patches.
type PatchInput = Omit<Partial<TinstarConfigClient>, 'ui'> & { ui?: Partial<TinstarConfigClient['ui']> }

interface Ctx {
  config: TinstarConfigClient | null
  patch: (p: PatchInput) => Promise<void>
}

const ConfigContext = createContext<Ctx>({ config: null, patch: async () => {} })

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<TinstarConfigClient | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/config')
      .then(r => r.json())
      .then(j => { if (!cancelled && j?.ok) setConfig(j.data as TinstarConfigClient) })
      .catch(() => { /* boot proceeds with null; consumers handle */ })
    return () => { cancelled = true }
  }, [])

  const patch = useCallback(async (p: PatchInput) => {
    // Optimistic update — shallow at top-level, shallow at ui-level
    setConfig(prev => prev ? mergeShallowTwoLevels(prev, p) : prev)
    try {
      const r = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
      const j = await r.json()
      if (j?.ok) setConfig(j.data as TinstarConfigClient)
      else throw new Error(j?.error?.message ?? 'patch failed')
    } catch (err) {
      // Best-effort rollback: re-fetch authoritative state
      apiFetch('/api/config').then(r => r.json()).then(j => { if (j?.ok) setConfig(j.data) }).catch(() => {})
      throw err
    }
  }, [])

  return <ConfigContext.Provider value={{ config, patch }}>{children}</ConfigContext.Provider>
}

export function useConfig(): TinstarConfigClient | null {
  return useContext(ConfigContext).config
}

export function useConfigPatch(): (p: PatchInput) => Promise<void> {
  return useContext(ConfigContext).patch
}

export function useDebouncedConfigPatch(ms: number): (p: PatchInput) => void {
  const patch = useConfigPatch()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<PatchInput>({})

  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return useCallback((p: PatchInput) => {
    pendingRef.current = mergeShallowTwoLevels(pendingRef.current as TinstarConfigClient, p) as unknown as PatchInput
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const snapshot = pendingRef.current
      pendingRef.current = {}
      timerRef.current = null
      patch(snapshot).catch(() => { /* surfaced by patch's own rollback */ })
    }, ms)
  }, [patch, ms])
}

function mergeShallowTwoLevels(a: TinstarConfigClient | Record<string, unknown>, b: Partial<TinstarConfigClient> | Record<string, unknown>): TinstarConfigClient {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
  for (const k of Object.keys(b as Record<string, unknown>)) {
    const av = (a as Record<string, unknown>)[k]
    const bv = (b as Record<string, unknown>)[k]
    if (av && typeof av === 'object' && !Array.isArray(av)
      && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = { ...(av as object), ...(bv as object) }
    } else if (bv !== undefined) {
      out[k] = bv
    }
  }
  return out as TinstarConfigClient
}
