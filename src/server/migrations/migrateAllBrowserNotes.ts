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
 *  per-space PinSet store. Groups browser widgets by spaceId; for each space
 *  whose PinSet is absent or empty, seeds it with the pins migrated from every
 *  browser widget in that space. Spaces whose PinSet already holds pins are left
 *  untouched (a real PinSet means the user is already on the new system) — this
 *  makes the migration safe to run on every load. Widget.notes are NOT removed
 *  (rollback safety net). */
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
    // Guard: never clobber a space that already has pins — it's already migrated
    // or the user has created pins on the new system.
    if (existing && existing.pins.length > 0) {
      skippedExisting.push(spaceId)
      continue
    }
    // Beat any existing (empty) PinSet's revision so the upsert gate accepts it.
    const rev = (existing?.rev ?? 0) + 1
    store.upsertPinSet(spaceId, { spaceId, pins, rev })
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
