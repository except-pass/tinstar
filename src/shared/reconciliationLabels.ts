/** Display labels never replace source identity or ownership. */
export function homeLabel(source: { home: string; label?: string }) {
  return source.label?.trim() || source.home.split('/').filter(Boolean).at(-1)?.replace(/^fm-/, '') || 'Unknown manager'
}
