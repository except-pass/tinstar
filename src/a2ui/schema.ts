// A2UI content schema — the protocol boundary for Roundup notices (KTD1, KTD5).
//
// We adopt A2UI's *schema* (the protocol), not its runtime. This module narrows
// web_core's v0_9 zod schemas to exactly what a read-only notice needs and wraps
// them in a small host envelope, so both the API (server-side validation) and the
// renderer (defense-in-depth revalidation) parse a notice's `content` through the
// same genuine A2UI schema. We deliberately do NOT touch web_core's
// MessageProcessor / ComponentContext / GenericBinder runtime or its basic_catalog
// styled components — those are for live, interactive, self-styled surfaces (a
// later slice). See docs/plans/2026-07-17-002-feat-roundup-a2ui-rendering-plan.md.
//
// Runtime-safe: no React, no browser globals — this file is imported by the
// server bundle (esbuild) as well as the client bundle (vite), which is exactly
// the dependency-bundling de-risk this slice exists to answer.
import { z } from 'zod'
// web_core only exposes its v0_9 surface through the package barrel (its exports
// map has no per-file subpath), so we import the two schema atoms we adopt from
// there. `sideEffects: false` lets both bundlers tree-shake the unused runtime.
import { AnyComponentSchema, ComponentIdSchema } from '@a2ui/web_core/v0_9'
import type { A2uiContent as DomainA2uiContent } from '../domain/types'

/** A2UI's `AnyComponent`: a `component` type string, an optional `id`, an
 *  optional layout `weight`, and arbitrary passthrough props. This is the actual
 *  protocol unit — the host renderer's catalog decides which `component` strings
 *  it knows how to draw, and degrades on the rest (R16). */
export const A2uiComponentSchema = AnyComponentSchema

/** A notice's content: a non-empty flat component list plus an explicit `root`
 *  id naming the entry node. Strict so an agent that misnames the envelope keys
 *  is rejected at the API rather than silently rendering blank. */
export const A2uiContentSchema = z
  .object({
    root: ComponentIdSchema,
    components: z.array(A2uiComponentSchema).min(1),
  })
  .strict()

/** The identity constraint below is what makes `A2uiContent` double as a
 *  compile-time guard: the web_core-derived parse output must remain assignable
 *  to the host storage type. If web_core's AnyComponent shape shifts under us
 *  (KTD3: this is a volatile dependency) and breaks that assignability, this
 *  alias fails typecheck instead of the mismatch escaping to runtime. */
type EnsureAssignable<T extends DomainA2uiContent> = T

/** Parsed A2UI content — structurally compatible with the host-owned
 *  `domain/types.ts` `A2uiContent` (the storage type) by construction. */
export type A2uiContent = EnsureAssignable<z.infer<typeof A2uiContentSchema>>

/** Validate an unknown value as A2UI content. Returns the parsed content on
 *  success or `null` on any schema failure — the single funnel both the API
 *  (reject) and the renderer (degrade) call, so "valid A2UI" means one thing. */
export function parseA2uiContent(value: unknown): A2uiContent | null {
  const result = A2uiContentSchema.safeParse(value)
  return result.success ? result.data : null
}
