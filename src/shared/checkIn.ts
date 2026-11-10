/** Check-ins are appointments. Date-only appointments are 9 AM New York,
 * including on DST transition days; never use the server's local timezone. */
export const CHECK_IN_ZONE = 'America/New_York'
export function zonedTime(value: string, zone = CHECK_IN_ZONE): number {
  const target = Date.parse(`${value}Z`)
  if (!Number.isFinite(target)) return NaN
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    let time = target
    for (let i = 0; i < 3; i++) {
      const parts = format.formatToParts(time), part = (name: string) => parts.find(p => p.type === name)!.value
      const rendered = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
      const delta = target - (Date.parse(`${rendered}Z`) + new Date(time).getUTCMilliseconds())
      if (!delta) return time
      time += delta
    }
  } catch { /* invalid remote timezone is unknown */ }
  return NaN
}
export function checkInTime(value: string | null, zone?: string | null): number {
  if (!value) return NaN
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = Date.parse(`${value}T00:00:00Z`)
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value) return NaN
    return zonedTime(`${value}T09:00:00`)
  }
  // ISO timestamps without offsets in Notion use the date property's timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return NaN
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : zonedTime(value, zone ?? CHECK_IN_ZONE)
}
export function checkInKey(cardId: string, value: string, zone?: string | null): string {
  return JSON.stringify([cardId.replaceAll('-', '').toLowerCase(), new Date(checkInTime(value, zone)).toISOString()])
}
/** Board policy: 8 AM–8 PM ET on business days; outside that window the
 * next appointment is no later than 10 AM the next business morning. */
export function checkInCeiling(at: number): number {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: CHECK_IN_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' })
  const parts = format.formatToParts(at), part = (name: string) => Number(parts.find(p => p.type === name)!.value)
  const day = Date.UTC(part('year'), part('month') - 1, part('day')), weekday = new Date(day).getUTCDay()
  let next = day + (weekday !== 0 && weekday !== 6 && part('hour') < 8 ? 0 : 86400_000)
  while ([0, 6].includes(new Date(next).getUTCDay())) next += 86400_000
  const morning = zonedTime(`${new Date(next).toISOString().slice(0, 10)}T10:00:00`)
  return weekday !== 0 && weekday !== 6 && part('hour') >= 8 && part('hour') < 20 ? Math.min(at + 4 * 3600_000, morning) : morning
}
export interface CheckInIndicator {
  requestId: string
  originalCheckpoint: string
  state: 'due' | 'requested' | 'acknowledged' | 'responded' | 'needs-attention'
  requestedAt: string | null
  answered: boolean
}
export function checkInIndicatorText(value: CheckInIndicator): string {
  if (value.answered) return 'Answered; Notion update pending'
  if (value.state === 'needs-attention') return 'Check-in unresolved · Awaiting First Mate follow-up'
  if (!value.requestedAt) return 'Check-in due · Awaiting First Mate delivery'
  const at = new Intl.DateTimeFormat('en-US', { timeZone: CHECK_IN_ZONE, hour: 'numeric', minute: '2-digit' }).format(Date.parse(value.requestedAt))
  return `Check-in requested ${at} ET · Awaiting First Mate`
}
