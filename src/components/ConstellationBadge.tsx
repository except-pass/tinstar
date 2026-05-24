interface Props {
  slots: string[]  // e.g. ['1', '3', '5']
  testId?: string
}

export function ConstellationBadge({ slots, testId }: Props) {
  if (slots.length === 0) return null

  const displayed = slots.slice(0, 3)
  const overflow = slots.length - 3

  return (
    <span
      data-testid={testId}
      className="text-slate-400 text-xs whitespace-nowrap select-none"
    >
      ⌨ {displayed.join(' ')}{overflow > 0 ? ` +${overflow}` : ''}
    </span>
  )
}
