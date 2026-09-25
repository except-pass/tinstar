import type { NeedsYouType } from '../contract/needsyou'

export function NeedsYouIcon({ type }: { type: NeedsYouType }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true as const,
    'data-icon-shape': type,
  }
  if (type === 'decision') {
    return (
      <svg {...common}>
        <path d="M8 1.5v13M3 4.5h10M4 4.5 2.5 8h3L4 4.5Zm8 0L10.5 8h3L12 4.5Z" />
      </svg>
    )
  }
  if (type === 'blocked') {
    return (
      <svg {...common}>
        <path d="M5 2.5h6l2.5 2.5v6L11 13.5H5L2.5 11V5L5 2.5Z" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
      </svg>
    )
  }
  if (type === 'failure') {
    return (
      <svg {...common}>
        <path d="M8 2 14.5 13.5h-13L8 2Z" />
        <path d="M8 6.5v3.5M8 12h.01" />
      </svg>
    )
  }
  if (type === 'schedule-drift') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3.2l2 1.3" />
      </svg>
    )
  }
  if (type === 'contradiction') {
    return (
      <svg {...common}>
        <path d="M2 5h8M8 3l2 2-2 2M14 11H6M8 9l-2 2 2 2" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M4 2.5h5l3 3V13.5H4v-11Z" />
      <path d="M9 2.5V6h3M6 9h4M6 11.5h3" />
    </svg>
  )
}
