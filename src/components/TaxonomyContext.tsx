import { createContext, useContext, type ReactNode } from 'react'
import type { TaxonomyRepository } from '../domain/repositories'

const TaxonomyContext = createContext<TaxonomyRepository | null>(null)

export function TaxonomyProvider({ taxRepo, children }: { taxRepo: TaxonomyRepository; children: ReactNode }) {
  return <TaxonomyContext.Provider value={taxRepo}>{children}</TaxonomyContext.Provider>
}

export function useTaxonomy(): TaxonomyRepository {
  const ctx = useContext(TaxonomyContext)
  if (!ctx) throw new Error('useTaxonomy must be used inside TaxonomyProvider')
  return ctx
}
