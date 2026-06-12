import type { DocumentStore } from '../stores/document-store'
import type { Pin } from '../../domain/pinSet'
import { migrateBrowserNotesToPins } from './migrateBrowserNotesToPins'

export interface MigrateAllResult {
  /** spaceIds that were seeded with migrated pins this run. */
  seeded: string[]
  /** spaceIds skipped because they already hold pins (already migrated / live). */
  skippedExisting: string[]
  /** ids of browser widgets with notes but no spaceId — their pins have no home. */
  orphanWidgetIds: string[]
}

/** One-time, idempotent migration of legacy browser `widget.notes` into the
 *  per-space PinSet store. Groups browser widgets by spaceId; seeds a space ONLY
 *  when it has no PinSet at all. A space with ANY PinSet — even an empty one (the
 *  user deleted every pin post-migration) — is left untouched, so deleted pins are
 *  never resurrected from the legacy widget.notes. This makes the migration safe to
 *  run on every load. Widget.notes are NOT removed (rollback safety net). */
export function migrateAllBrowserNotes(store: DocumentStore): MigrateAllResult {
  const seeded: string[] = []
  const skippedExisting: string[] = []
  const orphanWidgetIds: string[] = []

  // Group migrated pins by space; track space-less widgets separately.
  const pinsBySpace = new Map<string, Pin[]>()
  for (const w of store.getAllBrowserWidgets()) {
    if (!w.notes?.length) continue
    if (!w.spaceId) {
      orphanWidgetIds.push(w.id)
      continue
    }
    const pins = migrateBrowserNotesToPins(w.id, w.notes)
    if (!pins.length) continue
    const acc = pinsBySpace.get(w.spaceId)
    if (acc) acc.push(...pins)
    else pinsBySpace.set(w.spaceId, [...pins])
  }

  for (const [spaceId, pins] of pinsBySpace) {
    const existing = store.getPinSet(spaceId)
    // Guard: seed ONLY when the space has NO PinSet at all. Once migrated, a space
    // always has a PinSet — even an EMPTY one (the user deleted every pin). Reseeding
    // an empty PinSet would resurrect deleted pins from the legacy widget.notes, so we
    // must skip any existing PinSet, empty or not.
    if (existing) {
      skippedExisting.push(spaceId)
      continue
    }
    store.upsertPinSet(spaceId, { spaceId, pins, rev: 1 })
    seeded.push(spaceId)
  }

  if (orphanWidgetIds.length) {
    console.warn(
      `[migration] ${orphanWidgetIds.length} browser widget(s) with notes have no spaceId; ` +
        `their notes have no home space and were not migrated to pins:`,
      orphanWidgetIds,
    )
  }

  return { seeded, skippedExisting, orphanWidgetIds }
}
