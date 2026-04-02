import { useState, useEffect } from 'react'

interface Hand {
  name: string
  description: string
  cliTemplate: string
}

interface Props {
  sessionId: string
  onCollapse?: () => void
}

export function HandsPanel({ sessionId, onCollapse }: Props) {
  const [hands, setHands] = useState<Hand[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/hands')
      .then(res => res.json())
      .then(data => {
        if (data.ok) setHands(data.data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function handleDragStart(e: React.DragEvent, hand: Hand) {
    e.dataTransfer.setData('application/tinstar-hand', JSON.stringify({
      handName: hand.name,
      sessionId,
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  async function handleSpawn(handName: string, prompt?: string) {
    const res = await fetch(`/api/sessions/${sessionId}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hand: handName, prompt }),
    })
    const data = await res.json()
    if (!data.ok) {
      console.error('Spawn failed:', data.error)
    }
  }

  return (
    <section className="flex flex-col bg-surface-panel border-t border-primary/10">
      <div className="panel-header">
        <h3 className="panel-label flex items-center gap-1.5">
          <span>🤚</span>
          <span>Hands</span>
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs font-mono text-slate-600">{hands.length}</span>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="text-slate-500 hover:text-primary ml-1"
            >
              <span className="material-symbols-outlined text-sm">chevron_right</span>
            </button>
          )}
        </div>
      </div>

      <div data-scrollable className="flex-1 overflow-y-auto scrollbar-thin max-h-32">
        {loading ? (
          <div className="px-2 py-3 text-2xs font-mono text-slate-600 text-center animate-pulse">
            Loading...
          </div>
        ) : hands.length === 0 ? (
          <div className="px-2 py-3 text-2xs font-mono text-slate-700 text-center">
            No hands defined
          </div>
        ) : (
          hands.map(hand => (
            <div
              key={hand.name}
              draggable
              onDragStart={e => handleDragStart(e, hand)}
              onClick={() => handleSpawn(hand.name)}
              className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-primary/5 transition-colors cursor-grab active:cursor-grabbing"
              title={hand.description || hand.name}
            >
              <span className="text-xs">🤚</span>
              <span className="flex-1 text-2xs font-mono text-slate-400 group-hover:text-slate-300 truncate">
                {hand.name}
              </span>
            </div>
          ))
        )}
      </div>

      <button
        onClick={() => {
          const prompt = window.prompt('Enter prompt override (optional):')
          if (prompt !== null && hands.length > 0) {
            // For now, spawn the first hand with the custom prompt
            // TODO: Add hand selection dialog
            handleSpawn(hands[0]!.name, prompt || undefined)
          }
        }}
        className="m-2 flex items-center justify-center gap-1.5 py-1.5 border border-dashed border-primary/20 text-primary/40 hover:text-primary/70 hover:border-primary/40 transition-all rounded-sm"
        title="Spawn hand with custom prompt"
      >
        <span className="material-symbols-outlined text-sm">add</span>
        <span className="text-2xs font-bold font-display tracking-[0.12em] uppercase">Spawn</span>
      </button>
    </section>
  )
}
