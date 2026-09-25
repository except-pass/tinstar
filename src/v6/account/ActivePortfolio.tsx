import { useEffect, useState } from 'react'
import { apiFetch } from '../../apiClient'
import { PortfolioBoard, type PortfolioBoardProps } from '../portfolio'
import type { PortfolioDoc } from '../portfolio/types'

interface ActiveBoard {
  board: PortfolioDoc
  archivedEpicIds: string[]
}

async function loadActiveBoard(): Promise<ActiveBoard | null> {
  try {
    const res = await apiFetch('/api/v6/account/board')
    if (!res.ok) return null
    const body = await res.json() as { ok?: boolean; data?: { board?: PortfolioDoc; archivedEpicIds?: string[] } }
    if (!body.ok || !body.data?.board) return null
    return {
      board: body.data.board,
      archivedEpicIds: Array.isArray(body.data.archivedEpicIds) ? body.data.archivedEpicIds : [],
    }
  } catch {
    return null
  }
}

/**
 * Active board for the shell slot. Epics completed more than seven days
 * are already omitted by the account route. History stays on that route's epic read.
 */
export function ActivePortfolio(props: PortfolioBoardProps) {
  const [loaded, setLoaded] = useState<PortfolioDoc | null>(null)
  const [archived, setArchived] = useState<string[]>([])

  useEffect(() => {
    if (props.board) return
    let cancel = false
    void loadActiveBoard().then(result => {
      if (cancel || !result) return
      setLoaded(result.board)
      setArchived(result.archivedEpicIds)
    })
    return () => {
      cancel = true
    }
  }, [props.board])

  const board = props.board ?? loaded
  if (!board) return <p>No epics yet.</p>
  return (
    <>
      <PortfolioBoard {...props} board={board} />
      {archived.length > 0 ? (
        <p data-testid="account-archived" className="px-2 text-xs text-slate-400">
          {archived.length} completed {archived.length === 1 ? 'epic is' : 'epics are'} archived. History is kept.
        </p>
      ) : null}
    </>
  )
}
