// Derived staleness for Roundup notices. The implementation now lives in
// src/lib/relativeAge.ts (promoted so the Slate's surface-freshness signal shares
// it). This file re-exports the same names so existing Roundup imports (`./age`)
// keep working unchanged. Age is computed from a notice's `amendedAt` (the last
// time the AGENT tended it), so an old card recedes on its own — no new field, no
// status enum, no background job.
export { relativeAge, isStale, STALE_AFTER_MS } from '../../../lib/relativeAge'
