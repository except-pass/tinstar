import { describe, expect, it } from 'vitest'
import { deliverKeys, deliverPrompt, PromptDeliveryError, type Tmux } from './promptInput'

function scripted(steps: Array<(args: string[]) => string | undefined>): { tmux: Tmux; calls: string[][] } {
  const calls: string[][] = []
  const tmux: Tmux = async args => {
    calls.push(args)
    const step = steps.shift()
    if (!step) throw new Error(`unexpected tmux ${args.join(' ')}`)
    const out = step(args)
    return out ?? ''
  }
  return { tmux, calls }
}

const livePane = (args: string[]) => {
  if (args[0] === 'list-panes') return '1\t%7'
  if (args[0] === 'display-message') return '0'
  return ''
}

describe('deliverPrompt', () => {
  it('pastes the text into the worker pane and submits with Enter', async () => {
    const { tmux, calls } = scripted([livePane, livePane, () => '', () => '', () => ''])
    await deliverPrompt('firstmate:fm-alpha', 'hello composer', { tmux, settleMs: 0 })
    expect(calls[0]).toEqual(['list-panes', '-t', '=firstmate:fm-alpha', '-F', '#{pane_active}\t#{pane_id}'])
    expect(calls.some(args => args[0] === 'load-buffer')).toBe(true)
    const paste = calls.find(args => args[0] === 'paste-buffer')
    expect(paste).toEqual(['paste-buffer', '-d', '-r', '-p', '-b', expect.any(String), '-t', '%7'])
    expect(calls.at(-1)).toEqual(['send-keys', '-t', '%7', '', 'Enter'])
  })

  it('refuses a target that is not a worker window', async () => {
    const { tmux, calls } = scripted([])
    await expect(deliverPrompt('tsview-alpha:work', 'hi', { tmux, settleMs: 0 })).rejects.toBeInstanceOf(PromptDeliveryError)
    expect(calls).toEqual([])
  })

  it('cancels copy mode before pasting', async () => {
    let probes = 0
    const { tmux, calls } = scripted([
      livePane,
      () => { probes += 1; return probes === 1 ? '1' : '0' },
      () => '',
      () => '',
      () => '',
      () => '',
      () => '',
      () => '',
    ])
    await deliverPrompt('crew:work', 'after scroll', { tmux, settleMs: 0 })
    expect(calls.some(args => args.join(' ') === 'send-keys -X cancel -t %7')).toBe(true)
    expect(calls.findIndex(args => args[0] === 'paste-buffer')).toBeGreaterThan(calls.findIndex(args => args.includes('cancel')))
  })
})

describe('deliverKeys', () => {
  it('sends one composer key to the pane', async () => {
    const { tmux, calls } = scripted([livePane, livePane, () => ''])
    await deliverKeys('crew:work', ['y'], { tmux })
    expect(calls.at(-1)).toEqual(['send-keys', '-t', '%7', 'y'])
  })

  it('rejects a key the composer does not send', async () => {
    const { tmux } = scripted([])
    await expect(deliverKeys('crew:work', ['C-c'], { tmux })).rejects.toBeInstanceOf(PromptDeliveryError)
  })
})

