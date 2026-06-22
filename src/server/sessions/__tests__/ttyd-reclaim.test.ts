import { describe, expect, it } from 'vitest'
import { ttydPidsToReclaim, ttydPidsForSession, tmuxTargetFromArgs } from '../backends/tmux'

describe('tmuxTargetFromArgs — which tmux session a ttyd attaches', () => {
  it('parses the exact form startTtyd spawns', () => {
    // `ttyd -W -p <port> -t titleFixed=Tinstar -t theme={…} bash -c "tmux attach -t <name>"`
    const args = 'ttyd -W -p 8681 -t titleFixed=Tinstar -t theme={"background":"#000000"} bash -c tmux attach -t tinstar-foo'
    expect(tmuxTargetFromArgs(args)).toBe('tinstar-foo')
  })
  it('does not mistake ttyd\'s own -t option flags for the session token', () => {
    // The session is tinstar-foo, NOT 'titleFixed=Tinstar' (ttyd's -t flag).
    expect(tmuxTargetFromArgs('ttyd -t titleFixed=X bash -c tmux attach -t real-sess')).toBe('real-sess')
  })
  it('tolerates the attach-session alias and global flags (e.g. -L socket)', () => {
    expect(tmuxTargetFromArgs('bash -c tmux attach-session -t sess-a')).toBe('sess-a')
    expect(tmuxTargetFromArgs('bash -c tmux -L mysock attach -t sess-b')).toBe('sess-b')
  })
  it('returns null when there is no tmux attach in the args', () => {
    expect(tmuxTargetFromArgs('ttyd -p 8681 bash -c htop')).toBeNull()
    expect(tmuxTargetFromArgs('')).toBeNull()
  })
})

describe('ttydPidsToReclaim — which ttyds we may kill to take a port', () => {
  it('reclaims our own previous ttyd on the port', () => {
    const r = ttydPidsToReclaim(
      [{ pid: 100, tmuxTarget: 'tinstar-mysession' }],
      'tinstar-mysession',
    )
    expect(r.kill).toEqual([100])
    expect(r.foreign).toEqual([])
  })

  it('reclaims a ttyd whose tmux target we could not identify', () => {
    const r = ttydPidsToReclaim([{ pid: 101, tmuxTarget: null }], 'tinstar-mysession')
    expect(r.kill).toEqual([101])
    expect(r.foreign).toEqual([])
  })

  it('does NOT kill a ttyd serving a different session — that is the kill-war', () => {
    const r = ttydPidsToReclaim(
      [{ pid: 200, tmuxTarget: 'tinstar-other' }],
      'tinstar-mysession',
    )
    expect(r.kill).toEqual([])
    expect(r.foreign).toEqual([{ pid: 200, tmuxTarget: 'tinstar-other' }])
  })

  it('splits a mixed set correctly', () => {
    const r = ttydPidsToReclaim(
      [
        { pid: 1, tmuxTarget: 'tinstar-mine' },
        { pid: 2, tmuxTarget: 'tinstar-other' },
        { pid: 3, tmuxTarget: null },
      ],
      'tinstar-mine',
    )
    expect(r.kill.sort()).toEqual([1, 3])
    expect(r.foreign).toEqual([{ pid: 2, tmuxTarget: 'tinstar-other' }])
  })
})

describe('ttydPidsForSession — cross-port reaping of stale ttyds for one session', () => {
  it('reaps every ttyd attached to exactly our session, on any port', () => {
    const pids = ttydPidsForSession(
      [
        { pid: 1, tmuxTarget: 'tinstar-foo' }, // current
        { pid: 2, tmuxTarget: 'tinstar-foo' }, // orphan from a prior restart (other port)
      ],
      'tinstar-foo',
    )
    expect(pids.sort()).toEqual([1, 2])
  })

  it('never reaps a child hand session that merely shares the name prefix', () => {
    // Reclaiming the parent must not kill the ttyd serving tinstar-foo-reviewer-*.
    const pids = ttydPidsForSession(
      [
        { pid: 1, tmuxTarget: 'tinstar-foo' },
        { pid: 2, tmuxTarget: 'tinstar-foo-reviewer-ab12' },
        { pid: 3, tmuxTarget: 'tinstar-foo-general-purpose-cd34' },
      ],
      'tinstar-foo',
    )
    expect(pids).toEqual([1])
  })

  it('ignores ttyds for other sessions and unidentifiable ones', () => {
    const pids = ttydPidsForSession(
      [
        { pid: 1, tmuxTarget: 'tinstar-other' },
        { pid: 2, tmuxTarget: null },
      ],
      'tinstar-foo',
    )
    expect(pids).toEqual([])
  })
})
