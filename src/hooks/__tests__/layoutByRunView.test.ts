// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { generateDefaultLayouts } from '../useWidgetLayouts'
import { layoutWidgetType, registerWidgetComponent } from '../../widgets/widgetComponentRegistry'
import type { TreeNode } from '../../domain/types'

const run = (id: string, view?: string): TreeNode => ({
  id, label: id, type: 'run', entityId: id, children: [], runCount: 1, activeCount: 0, view,
})

const disposables: Array<{ dispose(): void }> = []
afterEach(() => { for (const d of disposables.splice(0)) d.dispose() })

describe('a run with a plugin view is laid out at that widget\'s own size', () => {
  it('uses the registered view widget size instead of the run-workspace default', () => {
    disposables.push(registerWidgetComponent({
      type: 'test-view', component: (() => null) as never, isContainer: false,
      defaultSize: { width: 1000, height: 560 }, minSize: { width: 520, height: 260 },
    }, 'plugin'))
    expect(layoutWidgetType(run('r', 'test-view'))).toBe('test-view')
    const l = generateDefaultLayouts([run('run-a', 'test-view')]).get('run-a')!
    expect([l.width, l.height]).toEqual([1000, 560])
  })

  it('falls back to the run-workspace type for no view or an unregistered one', () => {
    expect(layoutWidgetType(run('r'))).toBe('run-workspace')
    expect(layoutWidgetType(run('r', 'not-registered'))).toBe('run-workspace')
    expect(layoutWidgetType({ type: 'project' })).toBe('project')
  })
})
