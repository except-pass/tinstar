interface Props {
  slots: string[]  // e.g. ['1', '3', '5']
  testId?: string
  onLeave?: (slot: string) => void
}

export function ConstellationBadge({ slots, testId, onLeave }: Props) {
  if (slots.length === 0) return null

  const displayed = slots.slice(0, 3)
  const overflow = slots.length - 3

  return (
    <span
      data-testid={testId}
      className="text-slate-400 text-xs whitespace-nowrap select-none"
    >
      ⌨ {displayed.map((slot, i) => (
        <span key={slot}>
          {i > 0 ? ' ' : ''}
          {onLeave ? (
            <button
              type="button"
              data-testid={`${testId}-leave-${slot}`}
              className="hover:text-red-400 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); onLeave(slot) }}
              title={`Leave constellation ${slot}`}
            >
              {slot}
            </button>
          ) : (
            slot
          )}
        </span>
      ))}{overflow > 0 ? ` +${overflow}` : ''}
    </span>
  )
}
