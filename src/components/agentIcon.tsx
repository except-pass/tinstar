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
  icon: string | undefined | null
  fallback?: React.ReactNode
  className?: string
}

/**
 * Renders an agent template icon. Images get a fixed square box; text glyphs
 * render inline. Pass `className` to size the container (applies to both forms).
 */
export function AgentIcon({ icon, fallback, className = 'w-4 h-4' }: AgentIconProps) {
  if (isIconUrl(icon)) {
    return <img src={icon} alt="" aria-hidden="true" className={`${className} inline-block object-contain`} />
  }
  if (icon) {
    return <span aria-hidden="true">{icon}</span>
  }
  return <>{fallback ?? null}</>
}
