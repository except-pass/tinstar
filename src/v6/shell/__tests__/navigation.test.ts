import { describe, expect, it } from 'vitest'
import { adoptWorkers, cycleSelection, goBack, initialNav, jumpBoard } from '../navigation'

describe('shell navigation', () => {
  it('cycles every id in ascending order and keeps history off the cycle', () => {
    const start = adoptWorkers(initialNav(), ['b', 'a'])
    expect(start.selectedWorkerId).toBe('a')
    expect(start.history.current).toEqual({ kind: 'worker', id: 'a' })
    const next = cycleSelection(start, ['b', 'a'], 1)
    expect(next.selectedWorkerId).toBe('b')
    expect(next.history.past).toEqual([])
    const prev = cycleSelection(next, ['b', 'a'], -1)
    expect(prev.selectedWorkerId).toBe('a')
  })

  it('jumps to the portfolio in one step and back returns to the worker', () => {
    const worker = adoptWorkers(initialNav(), ['a'])
    const board = jumpBoard(worker)
    expect(board.history.current).toEqual({ kind: 'portfolio' })
    expect(board.history.past).toEqual([{ kind: 'worker', id: 'a' }])
    expect(board.history.past.some(view => view.kind === 'task' || view.kind === 'epic')).toBe(false)
    expect(goBack(board).history.current).toEqual({ kind: 'worker', id: 'a' })
  })

  it('does not change the view when the same workers are adopted again', () => {
    const worker = adoptWorkers(initialNav(), ['a', 'b'])
    const board = jumpBoard(cycleSelection(worker, ['a', 'b'], 1))
    const again = adoptWorkers(board, ['b', 'a'])
    expect(again).toBe(board)
  })
})
