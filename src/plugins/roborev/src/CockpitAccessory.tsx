// PLACEHOLDER — real implementation in Task 7.
import type { ComponentType } from 'react'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'

export function makeCockpitAccessory(_api: TinstarPluginAPI): ComponentType {
  return function CockpitAccessory() {
    return <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>roborev cockpit</div>
  }
}
