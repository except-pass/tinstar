interface DimensionIconProps {
  icon: string
  className?: string
}

/** Render dimension metadata as a Material Symbols ligature.
 * Emoji configured as custom dimension icons fall back to the browser's emoji font. */
export function DimensionIcon({ icon, className = '' }: DimensionIconProps) {
  return (
    <span
      className={`material-symbols-outlined leading-none ${className}`.trim()}
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}
