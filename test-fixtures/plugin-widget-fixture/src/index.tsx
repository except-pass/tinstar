import React from 'react'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'

function makeFixtureWidget(api: TinstarPluginAPI) {
  return function FixtureWidget() {
    const [data, setData] = api.widget.useData<{ counter?: number }>()
    const deleteMe = api.widget.useDelete()
    const counter = data?.counter ?? 0
    return (
      <div data-testid="fixture-widget" style={{
        padding: 12, color: '#e5e7eb', background: '#111827',
        height: '100%', display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div data-testid="fixture-counter" style={{ fontSize: 20 }}>{counter}</div>
        <button data-testid="fixture-increment" onClick={() => setData({ counter: counter + 1 })}>
          +1
        </button>
        <button data-testid="fixture-delete" onClick={() => deleteMe()}>
          delete
        </button>
      </div>
    )
  }
}

export function activate(api: TinstarPluginAPI) {
  const Component = makeFixtureWidget(api)
  return [
    api.widgets.register({
      type: 'fixture-widget',
      component: Component,
      isContainer: false,
      defaultSize: { width: 320, height: 200 },
      minSize: { width: 200, height: 120 },
    }),
    api.widgets.register({
      type: 'fixture-singleton-widget',
      component: Component,
      isContainer: false,
      defaultSize: { width: 320, height: 200 },
      minSize: { width: 200, height: 120 },
    }),
  ]
}
