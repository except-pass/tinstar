import { getApiBase } from '../apiBase.js'

export async function run() {
  const base = getApiBase()
  const response = await fetch(`${base}/api/fleet`)
  if (!response.ok) throw new Error(`Tin Star unavailable: HTTP ${response.status}`)
  const body = await response.json()
  const fleet = body.data ?? body
  console.log(`workers: ${fleet.workers?.length ?? 0}`)
  console.log(`attention: ${fleet.attention?.length ?? 0}`)
}
