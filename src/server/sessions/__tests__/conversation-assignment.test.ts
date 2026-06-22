import { describe, expect, it } from 'vitest'
import { decideConversationId, planSharedDirAssignments } from '../status-watcher'

type Tx = { convId: string; mtimeMs: number; birthtimeMs: number }

describe('decideConversationId — single-session decision', () => {
  const transcripts: Tx[] = [
    { convId: 'mine', mtimeMs: 100, birthtimeMs: 10 },
    { convId: 'fresh', mtimeMs: 300, birthtimeMs: 200 },
  ]

  it('keeps its own file even when a newer unclaimed transcript exists (orphan-safe)', () => {
    // A newer unclaimed transcript in the dir is NOT adopted. In a shared workdir
    // it is almost always an orphan (dead peer, or a headless `claude -p` review
    // run), filesystem-indistinguishable from a legit in-place /clear successor.
    // Adopting it caused live sessions to hop onto strangers' transcripts ->
    // wrong status lights + telemetry misattribution. Attribution beats live
    // /clear discovery; an in-place /clear re-tracks on relaunch/resume.
    const got = decideConversationId({
      currentConvId: 'mine',
      sessionCreatedMs: 0,
      transcripts,
      claimedByPeers: new Set(),
    })
    expect(got).toBe('mine')
  })

  it('keeps the current convId when nothing newer is available', () => {
    const got = decideConversationId({
      currentConvId: 'fresh',
      sessionCreatedMs: 0,
      transcripts,
      claimedByPeers: new Set(),
    })
    expect(got).toBe('fresh')
  })

  it('does not adopt a transcript a peer already claims', () => {
    const got = decideConversationId({
      currentConvId: 'mine',
      sessionCreatedMs: 0,
      transcripts,
      claimedByPeers: new Set(['fresh']),
    })
    expect(got).toBe('mine')
  })

  it('when current convId is contested, repairs to its own file born after session start', () => {
    // Two sessions cross-pollinated onto 'shared'. This session started at t=150,
    // its real file 'mine2' was born at t=160 (after start); the peer's older
    // file 'peer' (born t=5) must be excluded by the birthtime floor.
    const tx: Tx[] = [
      { convId: 'shared', mtimeMs: 500, birthtimeMs: 300 },
      { convId: 'peer', mtimeMs: 400, birthtimeMs: 5 },
      { convId: 'mine2', mtimeMs: 200, birthtimeMs: 160 },
    ]
    const got = decideConversationId({
      currentConvId: 'shared',
      sessionCreatedMs: 150,
      transcripts: tx,
      claimedByPeers: new Set(['shared']),
    })
    expect(got).toBe('mine2')
  })
})

describe('planSharedDirAssignments — multi-session fixpoint (no oscillation)', () => {
  // The production bug: two sessions in one workdir + a newer ORPHAN transcript
  // (left by a closed session) flip-flopped every 3s — both "adopt newer", then
  // both "repair contested", forever (186k log lines). A correct assignment is
  // a fixpoint: re-running it on its own output changes nothing.
  const orphanNewest: Tx[] = [
    { convId: 'A-real', mtimeMs: 100, birthtimeMs: 10 },
    { convId: 'B-real', mtimeMs: 200, birthtimeMs: 20 },
    { convId: 'orphan', mtimeMs: 300, birthtimeMs: 150 }, // newest, unowned
  ]

  it('converges to a stable, distinct assignment in one tick', () => {
    const sessions = [
      { name: 'A', convId: 'A-real', createdMs: 0 },
      { name: 'B', convId: 'B-real', createdMs: 0 },
    ]
    const round1 = planSharedDirAssignments(sessions, orphanNewest)

    // Feed the result back in — a correct assignment does not change.
    const round2 = planSharedDirAssignments(
      sessions.map((s) => ({ ...s, convId: round1.get(s.name)! })),
      orphanNewest,
    )
    expect([...round2]).toEqual([...round1])

    // No two sessions may share a convId.
    expect(round1.get('A')).not.toBe(round1.get('B'))

    // ...and each session keeps its OWN file — neither adopts the newer orphan.
    // (Stable-but-misattributed is still misattributed: this is the real bug.)
    expect(round1.get('A')).toBe('A-real')
    expect(round1.get('B')).toBe('B-real')
  })

  it('a lone session keeps its own file even when a newer unclaimed transcript exists', () => {
    // Even a lone session does not chase the newest file: a shared workdir
    // accumulates orphans (e.g. headless `claude -p` review runs) in the same
    // dir, and the lone session was observed hopping onto one. In-place /clear
    // is sacrificed for correct attribution; it re-tracks on relaunch/resume.
    const sessions = [{ name: 'A', convId: 'A-real', createdMs: 0 }]
    const tx: Tx[] = [
      { convId: 'A-real', mtimeMs: 100, birthtimeMs: 10 },
      { convId: 'A-cleared', mtimeMs: 400, birthtimeMs: 300 },
    ]
    const got = planSharedDirAssignments(sessions, tx)
    expect(got.get('A')).toBe('A-real')
  })

  it('two sessions with no orphan each keep their own file', () => {
    const sessions = [
      { name: 'A', convId: 'A-real', createdMs: 0 },
      { name: 'B', convId: 'B-real', createdMs: 0 },
    ]
    const tx: Tx[] = [
      { convId: 'A-real', mtimeMs: 100, birthtimeMs: 10 },
      { convId: 'B-real', mtimeMs: 200, birthtimeMs: 20 },
    ]
    const got = planSharedDirAssignments(sessions, tx)
    expect(got.get('A')).toBe('A-real')
    expect(got.get('B')).toBe('B-real')
  })
})
