import { describe, expect, it } from 'vitest'
import { resolveFocusWorkspaceLayout } from '../focusLayout'

const base = {
  width: 1400,
  filesCollapsed: false,
  filesWidth: 180,
  slateVisible: true,
  slateWidth: 320,
  telemetryCollapsed: false,
}

describe('resolveFocusWorkspaceLayout', () => {
  it('keeps the normal composition when the side regions and 640px session pane fit', () => {
    expect(resolveFocusWorkspaceLayout(base)).toEqual({
      constrained: false,
      fullDemand: 1300,
      filesRail: false,
      telemetryRail: false,
      slateWidth: 320,
    })
  })

  it('turns support panels into rails below the content-derived threshold', () => {
    expect(resolveFocusWorkspaceLayout({ ...base, width: 1200 })).toEqual({
      constrained: true,
      fullDemand: 1300,
      filesRail: true,
      telemetryRail: true,
      slateWidth: 320,
    })
  })

  it('clamps a wide Slate to forty percent while respecting its minimum', () => {
    expect(resolveFocusWorkspaceLayout({ ...base, width: 1000, slateWidth: 900 }).slateWidth).toBe(400)
    expect(resolveFocusWorkspaceLayout({ ...base, width: 600, slateWidth: 900 }).slateWidth).toBe(260)
  })

  it('uses the existing Slate opener and collapsed panel rails in full demand', () => {
    const layout = resolveFocusWorkspaceLayout({
      ...base,
      width: 900,
      filesCollapsed: true,
      telemetryCollapsed: true,
      slateVisible: false,
    })
    expect(layout.fullDemand).toBe(716)
    expect(layout.constrained).toBe(false)
    expect(layout.filesRail).toBe(true)
    expect(layout.telemetryRail).toBe(true)
    expect(layout.slateWidth).toBeNull()
  })
})
