import { useEffect, useState } from 'react'
import { getAvatarDataUrl, subscribeAvatarCache } from './agentAvatarCache'

/**
 * Agent icon helpers.
 *
 * A template's `icon` field is either:
 *   - a short text glyph (emoji or unicode char), e.g. "⚡", "◆"
 *   - a URL/path to an image, e.g. "/agent-icons/anthropic.svg", "https://…"
 *
 * `isIconUrl` distinguishes the two so the UI can render `<img>` for images
 * and text for glyphs.
 */
export function isIconUrl(icon: string | undefined | null): icon is string {
  if (!icon) return false
  return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:')
}

interface AgentIconProps {
  icon?: string | undefined | null
  /** Seed for procedural DiceBear fallback when `icon` is absent. Usually run.id. */
  seed?: string | null
  /** Accent color for procedural DiceBear fallback. Usually run.color. Hex. */
  color?: string | null
  fallback?: React.ReactNode
  className?: string
}

/**
 * Renders an agent template icon. Fallback order:
 *   1. explicit `icon` (emoji or URL)
 *   2. procedural DiceBear `bottts-neutral` seeded by `seed`, tinted by `color`
 *   3. caller-provided `fallback`
 */
export function AgentIcon({ icon, seed, color, fallback, className = 'w-4 h-4' }: AgentIconProps) {
  if (isIconUrl(icon)) {
    return <img src={icon} alt="" aria-hidden="true" className={`${className} inline-block object-contain`} />
  }
  if (icon) {
    return <span aria-hidden="true">{icon}</span>
  }
  if (seed) {
    return <ProceduralAvatar seed={seed} color={color ?? '#64748b'} className={className} />
  }
  return <>{fallback ?? null}</>
}

function ProceduralAvatar({ seed, color, className }: { seed: string; color: string; className: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => getAvatarDataUrl(seed, color))

  useEffect(() => {
    if (dataUrl) return
    const unsubscribe = subscribeAvatarCache(() => {
      const hit = getAvatarDataUrl(seed, color)
      if (hit) setDataUrl(hit)
    })
    // Re-check once immediately in case the cache was populated between render and effect.
    const hit = getAvatarDataUrl(seed, color)
    if (hit) setDataUrl(hit)
    return unsubscribe
  }, [seed, color])

  if (dataUrl) {
    return <img src={dataUrl} alt="" aria-hidden="true" className={`${className} inline-block object-contain`} />
  }
  return (
    <span
      data-testid="agent-icon-placeholder"
      aria-hidden="true"
      className={`${className} inline-block rounded-full`}
      style={{ background: color, opacity: 0.6 }}
    />
  )
}
