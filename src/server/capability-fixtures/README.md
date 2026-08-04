# Provider capability fixtures

A **characterization layer**: frozen recordings of what each agent CLI natively
emits today, captured *before* any provider abstraction exists.

This is not a contract. Nothing here is normalized, and nothing here should be
imported by production code. The point is to have a red line the provider
capability plane must hold against — "this is what the source actually gives us,
including the cases where it gives us nothing".

## What is covered

| Area | Fixtures | Test |
| --- | --- | --- |
| Claude statusline quota + per-session context | `claude/statusline-*.json` | `__tests__/claude-statusline.test.ts` |
| Claude OTLP → Prometheus telemetry | `claude/telemetry-otlp.json` | `__tests__/claude-telemetry.test.ts` |
| Codex rollout JSONL: `token_count`, thread lineage, compaction, recap | `codex/rollout-*.jsonl` | `__tests__/codex-rollout.test.ts` |
| tmux liveness and per-provider modal chrome | `terminal/*.txt` | `__tests__/terminal-liveness.test.ts` |

Every suite mixes two kinds of assertion, deliberately:

- **Behavioural** — the fixture is fed to the *real* reader (`CcQuotaService`,
  `TelemetryQuery`, `readCodexStatus`, `parseCodexRecapEntries`, `captureScreen`,
  `tmuxHasSession`), so a change in derivation fails here.
- **Structural** — for signals that have *no* reader yet (Codex `token_count` is
  the big one), the native shape is pinned directly. That block is the spec the
  future normalizer has to satisfy.

Some behavioural assertions intentionally overlap narrower production-unit
tests. The overlap is the seam: these suites drive a complete native fixture
through the real reader, while the adjacent unit suites isolate reader mechanics.
If a reader contract changes, update both views together.

Absent and partial fields are first-class: a fresh Claude session with no
`rate_limits`, a `context_window` missing its size, a Codex `token_count` with
no `rate_limits` / no `model_context_window` / a null `info`, a truncated final
JSONL line. Those are the shapes that break normalizers quietly.

## Two findings worth carrying forward

- **`readCodexStatus` reports `running` for an aborted turn.** `turn_aborted`,
  `context_compacted`, `compacted` and `token_count` are all unrecognized, so the
  reader walks back to `task_started`. Pinned as a KNOWN GAP test in
  `codex-rollout.test.ts` so the provider plane closes it on purpose.
- **Codex `rate_limits` sits *beside* `info`, not inside it**, and expresses
  quota as `used_percent` + `window_minutes` + epoch `resets_at` — not Claude's
  fixed `five_hour` / `seven_day` buckets. A shared quota type has to carry the
  window length as data.

## Provenance and sanitization

Shapes were derived from real artifacts on the capture machine on 2026-07-30:

- Claude statusline: the hook tap at `/tmp/tinstar-cc-quota-tap.json`, written by
  `~/.claude/tinstar/cc-quota-statusline.sh` (Claude Code 2.1.220).
- Codex rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (codex CLI
  0.140–0.146). `rollout-resumed-session.jsonl` was re-derived from a
  controlled interactive `codex` + `codex resume <session-id>` pair on 0.146:
  resume appended a second turn and `thread_settings_applied` to the existing
  rollout without a second `session_meta`.
- Terminal captures: `tmux capture-pane` against live Tinstar sessions.

**Every fixture is rewritten, not copied.** Field names, nesting, types, and
null-vs-absent distinctions are verbatim; all *values* are synthetic:

- session/thread/turn ids replaced with structured placeholders
- paths under `/home/fixture/repo/demo`, repo `fixture-org/demo`, zeroed commit hash
- prompts, agent messages, base/developer instructions, compaction history and
  `world_state` bodies replaced with `<fixture: … elided>` or one-line stand-ins
- quota percentages, costs and credit balances are made-up numbers

Do not add real account usage, tokens, credentials, prompts, or private
repository content to this directory.

## Refreshing a fixture

Re-derive the shape from a live artifact, then hand-rewrite the values. When a
CLI upgrade changes a shape, update the fixture **and** the assertion in the same
change — a fixture edited alone silently weakens the characterization.
Keep every present, parseable envelope timestamp in append order. Keep each
`task_started` epoch within two seconds before its envelope, and keep abort
duration within one second of the start/completion delta.
`rollout-malformed-tail` intentionally has no parseable `task_started`: its
non-JSON line stands in for that record.

## Not covered

- `discoverTranscript` (codex-transcript.ts) reads `~/.codex/sessions` from
  `homedir()` with no injection seam, so its cwd-match → pane-text-match ladder
  is not exercised here. The pane-text half of that rule (agent message sliced to
  120 chars, matched only when ≥30 chars) is untested.
- Cursor's trust *marker* logic already has coverage in
  `sessions/__tests__/cursor-trust.test.ts`; only the modal pane it pre-empts is
  frozen here.
- ttyd reclaim/restart liveness is covered by `sessions/__tests__/ttyd-*.test.ts`
  and is not duplicated.
