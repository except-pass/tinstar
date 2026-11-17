import { defaultOrganizer, type FloorGroup } from '../shared/floorOrganization'
import type { PresentationAction, PresentationState } from './presentation'
import { nextLevelCollapsed, overviewLevelControls, type LevelControl } from './overviewLevelCollapse'
import './levelToggles.css'

export function LevelToggles({ groups, state, send }: { groups: readonly FloorGroup[]; state: PresentationState; send: (action: PresentationAction) => void }) {
  const organizer = state.organizer ?? defaultOrganizer()
  const controls = overviewLevelControls(groups, state.collapsed, organizer)
  const activate = (control: LevelControl) => {
    if (control.disabled) return
    // One transition per group keeps the existing expansion sync. Child ids are not in this list.
    const expanded = control.action === 'expand'
    const collapsed = nextLevelCollapsed(state.collapsed, control.ids, control.action)
    for (const id of control.ids) {
      const present = state.collapsed.includes(id)
      if (present === collapsed.includes(id)) continue
      send({ type: 'set-expanded', target: { kind: 'group', id: id.slice(id.indexOf(':') + 1) }, expanded })
    }
  }
  return <div className="ov-level-toggles" role="group" aria-label="Hierarchy">{(['outer', 'inner'] as const).map(slot => {
    const control = controls[slot]
    const tier = slot === 'outer' ? 'one' : 'two'
    return <span key={slot} title={control.name}><button type="button" data-level={slot === 'outer' ? organizer.outer : organizer.inner} data-tier={tier} data-action={control.disabled ? undefined : control.action} aria-label={control.name} disabled={control.disabled} onClick={() => activate(control)}><LevelIcon tier={tier} action={control.disabled ? undefined : control.action} /></button></span>
  })}</div>
}

function LevelIcon({ tier, action }: { tier: 'one' | 'two'; action?: 'collapse' | 'expand' }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16">{tier === 'one'
    ? <path d="M1.5 4h8M1.5 8h8M1.5 12h8" />
    : <path d="M1.5 3.5h5M1.5 3.5v9M1.5 8h2M3.5 8h5M1.5 12.5h2M3.5 12.5h5" />}
  {action === 'collapse' && <path d="M12 8h3" />}
  {action === 'expand' && <path d="M12 8h3M13.5 6.5v3" />}
  </svg>
}
