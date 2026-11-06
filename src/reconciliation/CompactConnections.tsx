import { useLayoutEffect, useState, type RefObject } from 'react'
import type { FloorScene, Target } from './presentation'
import { AskRelationshipHit } from '../ask/Ask'
import { stale } from './overviewModel'

interface Path { id: string; worker: string; card: string; d: string; uncertain: boolean }
/** One measured layer spans groups, so deduplicated cross-group references can
 * connect to their canonical endpoint without inventing a local copy. */
export function CompactConnections({ canvas, scene, layout, expanded, collapsed, now, readFailed, focus }: {
  canvas: RefObject<HTMLDivElement>; scene: FloorScene; layout: unknown; expanded: ReadonlySet<string>; collapsed: string[]; now: number; readFailed: boolean; focus: Target | null
}) {
  const [paths, setPaths] = useState<Path[]>([])
  useLayoutEffect(() => {
    const root = canvas.current
    if (!root) return
    let frame = 0
    const draw = () => {
      const box = root.getBoundingClientRect()
      const workers = new Map([...root.querySelectorAll<HTMLElement>('.ov-execution')].map(el => [el.dataset.entityId, el]))
      const cards = new Map([...root.querySelectorAll<HTMLElement>('.ov-card')].map(el => [el.dataset.entityId, el]))
      const next: Path[] = [], seen = new Set<string>()
      for (const claim of scene.claims) {
        if (claim.basis !== 'explicit' || claim.verification !== 'confirmed' || claim.state !== 'current') continue
        const worker = workers.get(claim.executionId), card = cards.get(claim.cardId)
        const key = JSON.stringify([claim.executionId, claim.cardId])
        if (!worker || !card || seen.has(key)) continue
        seen.add(key)
        const a = worker.getBoundingClientRect(), b = card.getBoundingClientRect()
        const x = a.right - box.left, y = a.top - box.top + a.height / 2
        const x2 = b.left - box.left, y2 = b.top - box.top + b.height / 2
        // All curves stay within the narrow shared gutter, including cross-group links.
        const dx = (x2 - x) * .55
        const execution = scene.executions.find(e => e.id === claim.executionId)
        next.push({ id: claim.id, worker: claim.executionId, card: claim.cardId,
          d: `M${x},${y} C${x + dx},${y} ${x2 - dx},${y2} ${x2},${y2}`,
          uncertain: readFailed || stale(scene.coverage.intentions, now) || !execution || stale(execution.observation, now) })
      }
      setPaths(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw) }
    draw()
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    root.querySelectorAll('.ov-item').forEach(el => observer.observe(el))
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true) }
  }, [canvas, scene, layout, expanded, collapsed, now, readFailed])
  return <svg className="ov-connections ov-compact-connections">{paths.map(path => <g key={path.id}><path data-worker-id={path.worker} data-card-id={path.card} d={path.d}
    className={`ov-line ov-${path.uncertain ? 'uncertain' : 'linked'}${focus ? focus.kind === 'execution' && focus.id === path.worker || focus.kind === 'card' && focus.id === path.card ? ' hot' : ' dim' : ''}`} /><AskRelationshipHit claimId={path.id} d={path.d} /></g>)}</svg>
}
